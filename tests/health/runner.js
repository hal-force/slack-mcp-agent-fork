#!/usr/bin/env node
/**
 * Health-check runner for slack-mcp-agent.
 *
 * One entry point for both DEPLOY-TIME smoke tests and ONGOING monitoring
 * (model drift, context rot, config regressions). Designed to run against a
 * live deployment's environment — point it at prod/staging config and it
 * reports pass / warn / fail / skip per check, then exits non-zero if any check
 * FAILED (so it drops cleanly into a release phase or a scheduled cron).
 *
 * Usage:
 *   node tests/health/runner.js <suite> [--json] [--verbose]
 *
 * Suites:
 *   configcheck deterministic, NETWORK-FREE gate: config validation + SSRF
 *               self-test. This is the Heroku release-phase gate — it blocks a
 *               deploy on a real misconfiguration but never on a transient
 *               external outage.
 *   smoke       configcheck + live LLM & Tableau reachability pings
 *   drift       golden routing (offline) + golden prompt eval (live LLM)
 *   contextrot  datasource-catalog growth analysis (live + simulated)
 *   all         smoke + drift + contextrot
 *
 * Flags:
 *   --json     emit machine-readable JSON (for dashboards / alerting)
 *   --verbose  include per-item detail for drift/contextrot
 *   --live-tableau-scale=N   contextrot: also fetch the REAL catalog and report
 *
 * Exit codes: 0 = no failures (warns allowed), 1 = ≥1 fail, 2 = runner error.
 *
 * SAFETY: read-only. It performs Tableau list/metadata reads and LLM calls, and
 * NEVER writes to Slack, the database, or Tableau. It does not print secrets.
 */

const {
  validateDeployConfig,
  ssrfGuardSelfTest,
  scoreDriftCase,
  scoreRoutingCase,
  analyzeCatalogGrowth,
  parseDatasourceCatalog,
} = require("./lib/checks");
const { ROUTING_CASES, DRIFT_CASES } = require("./fixtures/golden-cases");
const { buildCatalogListText } = require("./fixtures/syntheticCatalog");

// ---- tiny console formatting (no deps) ----
const C = { reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m", cyan: "\x1b[36m" };
const ICON = { pass: "✔", warn: "⚠", fail: "✗", skip: "•" };
const COLOR = { pass: C.green, warn: C.yellow, fail: C.red, skip: C.dim };
function line(r) {
  const c = COLOR[r.status] || "";
  return `  ${c}${ICON[r.status] || "?"} ${r.status.toUpperCase().padEnd(4)}${C.reset} ${r.name} ${C.dim}— ${r.detail}${C.reset}`;
}
function header(t) {
  return `\n${C.cyan}══ ${t} ══${C.reset}`;
}

/** Timeout wrapper so a hung network call can't stall the whole run. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// CONFIGCHECK — deterministic, network-free deploy gate
// ---------------------------------------------------------------------------

/**
 * The subset of smoke checks that are DETERMINISTIC (no network): config
 * validation + the SSRF-guard self-test. This is what belongs in a Heroku
 * release phase — it blocks a deploy on a real misconfiguration (missing
 * secret, malformed TOKEN_ENC_KEY, private/non-https Tableau URL, silent
 * provider fallback, SSRF-guard regression) WITHOUT coupling "can I ship a
 * code fix" to "is Bedrock/Tableau reachable this exact second". Live
 * reachability lives in `smoke` (manual) and the scheduled monitor instead, so
 * a transient external blip can't roll back an unrelated deploy.
 */
function runConfigCheck() {
  const results = [];
  results.push(...validateDeployConfig(process.env));
  results.push(ssrfGuardSelfTest());
  return results;
}

// ---------------------------------------------------------------------------
// SMOKE — deploy-time readiness (config gate + live reachability)
// ---------------------------------------------------------------------------

async function runSmoke() {
  // 1) Everything the deterministic gate checks …
  const results = runConfigCheck();

  // 2) … plus live LLM reachability — a tiny real generation via generateReply.
  results.push(await pingLlm());

  // 3) Live Tableau MCP reachability — initialize a session and list a page.
  results.push(await pingTableau());

  return results;
}

async function pingLlm() {
  // Call generateReply DIRECTLY, not getAiResponse: getAiResponse intentionally
  // swallows provider errors and returns a friendly fallback string, so a
  // non-empty reply there is NOT proof the LLM is reachable. generateReply
  // throws on a real failure, which is the honest reachability signal.
  const { generateReply, selectedProvider } = require("../../src/assistant/llmProvider");
  try {
    const out = await withTimeout(
      generateReply(
        {
          systemInstruction: "You are a health probe. Answer in one word.",
          contents: [{ role: "user", parts: [{ text: "Reply with the single word: READY" }] }],
          maxOutputTokens: 16,
          temperature: 0,
        },
        {},
      ),
      Number(process.env.HEALTH_LLM_TIMEOUT_MS) || 30000,
      "LLM ping",
    );
    if (out && out.safety) {
      return { name: "LLM reachability", status: "warn", detail: `provider=${out.provider}: reachable but the probe was safety-blocked.` };
    }
    const text = (out && out.text) || "";
    if (!text.trim()) return { name: "LLM reachability", status: "fail", detail: `provider=${out && out.provider}: live call returned an empty reply.` };
    return { name: "LLM reachability", status: "pass", detail: `provider=${out.provider}: live reply received (${text.trim().length} chars).` };
  } catch (err) {
    return { name: "LLM reachability", status: "fail", detail: `provider=${selectedProvider()}: live call failed: ${err.message}` };
  }
}

async function pingTableau() {
  const { resolveTableauMcpUrl, ensureSession, callTableauTool, getDatasourceListLimit } = require("../../src/assistant/tableauMcpClient");
  const url = resolveTableauMcpUrl();
  if (!url) return { name: "Tableau MCP reachability", status: "skip", detail: "TABLEAU_MCP_SERVER not set — Tableau disabled." };
  try {
    await withTimeout(ensureSession(url), Number(process.env.HEALTH_MCP_TIMEOUT_MS) || 20000, "Tableau initialize");
    const { text } = await withTimeout(
      callTableauTool("list-datasources", { limit: getDatasourceListLimit() }, { tableauMcpBaseUrl: url }),
      Number(process.env.HEALTH_MCP_TIMEOUT_MS) || 20000,
      "Tableau list-datasources",
    );
    const catalog = parseDatasourceCatalog(text || "");
    if (catalog.length === 0) {
      return {
        name: "Tableau MCP reachability",
        status: "warn",
        detail: "session OK but list-datasources parsed to 0 rows (empty site, permissions, or a response-shape change).",
      };
    }
    return { name: "Tableau MCP reachability", status: "pass", detail: `session OK; parsed ${catalog.length} datasource(s).` };
  } catch (err) {
    return { name: "Tableau MCP reachability", status: "fail", detail: `MCP call failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// DRIFT — golden routing (offline) + golden prompt eval (live)
// ---------------------------------------------------------------------------

async function runDrift({ verbose } = {}) {
  const results = [];

  // 1) Offline: intent-router golden cases (deterministic; catches regex drift).
  const { classifyIntent } = require("../../src/router/intentRouter");
  const routeFails = [];
  for (const c of ROUTING_CASES) {
    const { intents } = classifyIntent(c.message, c.caps || {}, c.threadHint || "");
    const scored = scoreRoutingCase(c, intents);
    if (!scored.passed) routeFails.push(scored);
  }
  results.push(
    routeFails.length === 0
      ? { name: "Intent routing (golden)", status: "pass", detail: `${ROUTING_CASES.length}/${ROUTING_CASES.length} cases routed as expected.` }
      : {
          name: "Intent routing (golden)",
          status: "fail",
          detail: `${routeFails.length}/${ROUTING_CASES.length} routing cases drifted.`,
          items: verbose ? routeFails : undefined,
        },
  );

  // 2) Live: golden prompt eval through the real getAiResponse.
  const { getAiResponse } = require("../../src/assistant/respond");
  const driftFails = [];
  let ran = 0;
  for (const c of DRIFT_CASES) {
    try {
      const res = await withTimeout(
        getAiResponse({
          userMessage: c.userMessage,
          skillContext: c.skillContext,
          useFullModel: c.useFullModel || false,
        }),
        Number(process.env.HEALTH_LLM_TIMEOUT_MS) || 30000,
        `drift case ${c.id}`,
      );
      ran += 1;
      const scored = scoreDriftCase(c, res && res.text);
      if (!scored.passed) driftFails.push(scored);
    } catch (err) {
      driftFails.push({ id: c.id, passed: false, failures: [`live call failed: ${err.message}`] });
    }
  }
  if (ran === 0 && driftFails.length === DRIFT_CASES.length) {
    results.push({ name: "Model behavior (golden prompts)", status: "fail", detail: "no golden prompt completed — LLM unreachable?", items: verbose ? driftFails : undefined });
  } else {
    results.push(
      driftFails.length === 0
        ? { name: "Model behavior (golden prompts)", status: "pass", detail: `${DRIFT_CASES.length}/${DRIFT_CASES.length} behavioral checks held.` }
        : {
            name: "Model behavior (golden prompts)",
            status: "fail",
            detail: `${driftFails.length}/${DRIFT_CASES.length} golden prompts drifted (refusal / grounding / injection / leak).`,
            items: verbose ? driftFails : undefined,
          },
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// CONTEXT ROT — datasource catalog growth
// ---------------------------------------------------------------------------

async function runContextRot({ verbose, liveScale } = {}) {
  const results = [];
  const query = "show me the otf grants enriched data";

  // 1) Simulated growth: prove the ranker + display cap behave as the site scales.
  const scales = [50, 250, 500, 1000, 5000];
  const rows = [];
  for (const n of scales) {
    const { listText, target } = buildCatalogListText(n);
    const catalog = parseDatasourceCatalog(listText);
    const a = analyzeCatalogGrowth(catalog, { query, target: target.luid });
    rows.push({ n, analysis: a });
  }

  // Ranking must still resolve the buried target at EVERY scale.
  const rankBroken = rows.filter((r) => !r.analysis.target || r.analysis.target.rank !== 1);
  results.push(
    rankBroken.length === 0
      ? { name: "Datasource ranking under growth", status: "pass", detail: `target ranks #1 at all simulated scales (${scales.join(", ")}).` }
      : {
          name: "Datasource ranking under growth",
          status: "fail",
          detail: `target lost #1 rank at scale(s): ${rankBroken.map((r) => r.n).join(", ")}.`,
          items: verbose ? rankBroken.map((r) => ({ n: r.n, ...r.analysis.target })) : undefined,
        },
  );

  // Display-cap visibility: warn where growth hides datasources from the model.
  const capped = rows.filter((r) => r.analysis.hiddenRows > 0);
  results.push(
    capped.length === 0
      ? { name: "Catalog display coverage", status: "pass", detail: "no simulated scale exceeds the model's catalog display cap." }
      : {
          name: "Catalog display coverage",
          status: "warn",
          detail: `at ${capped.map((r) => `${r.n}→${r.analysis.hiddenRows} hidden`).join(", ")} datasources fall outside the ${rows[0].analysis.displayCap}-row cap the model sees.`,
          items: verbose ? capped.map((r) => ({ n: r.n, hidden: r.analysis.hiddenRows, approxTokens: r.analysis.approxTokens })) : undefined,
        },
  );

  // 2) Live catalog (optional): fetch the REAL catalog and report its size vs cap.
  if (liveScale) {
    results.push(await analyzeLiveCatalog(query, verbose));
  }

  return results;
}

async function analyzeLiveCatalog(query, verbose) {
  const { resolveTableauMcpUrl, ensureSession, callTableauTool, getDatasourceListLimit } = require("../../src/assistant/tableauMcpClient");
  const url = resolveTableauMcpUrl();
  if (!url) return { name: "Live catalog size", status: "skip", detail: "TABLEAU_MCP_SERVER not set." };
  try {
    await withTimeout(ensureSession(url), Number(process.env.HEALTH_MCP_TIMEOUT_MS) || 20000, "Tableau initialize");
    const { text } = await withTimeout(
      callTableauTool("list-datasources", { limit: getDatasourceListLimit() }, { tableauMcpBaseUrl: url }),
      Number(process.env.HEALTH_MCP_TIMEOUT_MS) || 20000,
      "Tableau list-datasources",
    );
    const catalog = parseDatasourceCatalog(text || "");
    const a = analyzeCatalogGrowth(catalog, { query });
    const listLimit = getDatasourceListLimit();
    const detailBits = [
      `${a.total} datasource(s) parsed (server limit=${listLimit})`,
      `~${a.approxTokens} tokens in the compact catalog`,
    ];
    // If the site has more datasources than our list limit, the server itself
    // truncated the catalog before we ever saw it — the deeper rot boundary.
    if (a.total >= listLimit) {
      detailBits.push(`the site likely has MORE than ${listLimit}; raise TABLEAU_MCP_DATASOURCE_LIST_LIMIT or add a name filter.`);
      return { name: "Live catalog size", status: "warn", detail: detailBits.join("; "), items: verbose ? [a] : undefined };
    }
    return { name: "Live catalog size", status: "pass", detail: detailBits.join("; "), items: verbose ? [a] : undefined };
  } catch (err) {
    return { name: "Live catalog size", status: "fail", detail: `live catalog fetch failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const suite = argv.find((a) => !a.startsWith("--")) || "smoke";
  const json = argv.includes("--json");
  const verbose = argv.includes("--verbose");
  const liveScaleArg = argv.find((a) => a.startsWith("--live-tableau-scale"));
  const liveScale = !!liveScaleArg;

  // getAiResponse() requires the app env; load dotenv so a local run picks up
  // .env. quiet:true suppresses dotenv's stdout banner, which would otherwise
  // corrupt --json output.
  try { require("dotenv").config({ quiet: true }); } catch (_) {}

  const sections = [];
  // configcheck is the deterministic subset (no network) — used as the release
  // gate. It is NOT part of `all`, which prefers the fuller live `smoke`.
  if (suite === "configcheck") sections.push(["Config check (deterministic deploy gate)", runConfigCheck()]);
  if (suite === "smoke" || suite === "all") sections.push(["Smoke (deploy readiness)", await runSmoke()]);
  if (suite === "drift" || suite === "all") sections.push(["Model & routing drift", await runDrift({ verbose })]);
  if (suite === "contextrot" || suite === "all") sections.push(["Context rot (datasource growth)", await runContextRot({ verbose, liveScale })]);

  if (sections.length === 0) {
    console.error(`Unknown suite "${suite}". Use: configcheck | smoke | drift | contextrot | all`);
    process.exit(2);
  }

  const all = sections.flatMap(([, rs]) => rs);
  const counts = all.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});

  if (json) {
    console.log(JSON.stringify({ suite, counts, sections: sections.map(([t, rs]) => ({ title: t, results: rs })) }, null, 2));
  } else {
    for (const [title, rs] of sections) {
      console.log(header(title));
      for (const r of rs) {
        console.log(line(r));
        if (verbose && Array.isArray(r.items)) {
          for (const it of r.items) console.log(`      ${C.dim}${JSON.stringify(it)}${C.reset}`);
        }
      }
    }
    console.log(
      `\n${C.cyan}Summary:${C.reset} ` +
        `${C.green}${counts.pass || 0} pass${C.reset}, ` +
        `${C.yellow}${counts.warn || 0} warn${C.reset}, ` +
        `${C.red}${counts.fail || 0} fail${C.reset}, ` +
        `${C.dim}${counts.skip || 0} skip${C.reset}`,
    );
  }

  process.exit((counts.fail || 0) > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("health runner error:", err && err.stack ? err.stack : err);
  process.exit(2);
});
