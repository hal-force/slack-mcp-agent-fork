/**
 * Pure, network-free check helpers for the health-check framework.
 *
 * Everything here is deterministic and importable so it can be unit-tested by
 * `npm test` (see tests/healthChecks.test.js) — the live runners in
 * ../runner.js call these and add the actual network I/O around them. Keeping
 * the judgement logic here (and out of the runner) means the rules that decide
 * "is this deploy healthy?" are themselves covered by tests and can't silently
 * drift.
 */

const {
  selectedProvider,
  gatewayConfig,
  bedrockConfig,
} = require("../../../src/assistant/llmProvider");
const { validateUserMcpUrl, classifyHost } = require("../../../src/assistant/urlSafety");
const {
  parseDatasourceCatalog,
  rankDatasourcesForMessage,
  formatDatasourceCatalogCompact,
} = require("../../../src/assistant/tableauContextBuilder");

// The compact datasource catalog that buildTableauContext feeds the model shows
// at most this many rows (formatDatasourceCatalogCompact default). Past this,
// rows are silently dropped from the model's view of "what datasources exist" —
// the core context-rot boundary as a customer's Tableau site grows.
const DATASOURCE_DISPLAY_CAP = 500;

// Rough chars→tokens ratio for a size estimate (good enough for a budget alarm).
const CHARS_PER_TOKEN = 4;

/** A single check result. status ∈ pass | warn | fail | skip. */
function result(name, status, detail, extra = {}) {
  return { name, status, detail, ...extra };
}

// ---------------------------------------------------------------------------
// Deploy-time config validation
// ---------------------------------------------------------------------------

/** True when a non-empty value is present in env. */
function has(env, key) {
  return typeof env[key] === "string" && env[key].trim() !== "";
}

/**
 * Report the effective LLM provider and whether it is fully configured.
 * Mirrors the app's own resolution by calling the real llmProvider functions
 * (single source of truth) so the health check can never claim a different
 * provider than the running app would pick.
 *
 * @returns {{ name: string, status: string, detail: string, provider: string }}
 */
function resolveLlmProviderStatus(env = process.env) {
  const requested = String(env.AI_PROVIDER || "").trim().toLowerCase();
  const effective = selectedProvider();

  // AI_PROVIDER asked for gateway/bedrock but that backend isn't fully
  // configured → selectedProvider() silently falls back to vertex. That is a
  // real misconfiguration to surface loudly at deploy time.
  if ((requested === "gateway" || requested === "bedrock") && effective === "vertex") {
    const which = requested === "gateway" ? "LLM_GATEWAY_*" : "Bedrock (BEDROCK_MODEL_ID/region/creds)";
    return result(
      "LLM provider",
      "fail",
      `AI_PROVIDER=${requested} but its config is incomplete (${which}); the app is silently falling back to vertex.`,
      { provider: effective },
    );
  }

  if (effective === "gateway") {
    return gatewayConfig()
      ? result("LLM provider", "pass", "gateway configured (URL + key + model).", { provider: effective })
      : result("LLM provider", "fail", "gateway selected but gatewayConfig() is null.", { provider: effective });
  }
  if (effective === "bedrock") {
    return bedrockConfig()
      ? result("LLM provider", "pass", "bedrock configured (model + region + creds).", { provider: effective })
      : result("LLM provider", "fail", "bedrock selected but bedrockConfig() is null.", { provider: effective });
  }
  // vertex — needs a project (either env var or a mounted service-account JSON).
  const vertexReady = has(env, "GOOGLE_CLOUD_PROJECT") || has(env, "GCP_SERVICE_ACCOUNT_JSON");
  return vertexReady
    ? result("LLM provider", "pass", "vertex configured (project / service account present).", { provider: effective })
    : result(
        "LLM provider",
        "warn",
        "vertex selected but neither GOOGLE_CLOUD_PROJECT nor GCP_SERVICE_ACCOUNT_JSON is set — live LLM calls will fail.",
        { provider: effective },
      );
}

/**
 * Validate the deploy configuration. Pure w.r.t. the injected env for presence
 * checks; provider resolution defers to the real llmProvider functions.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {{ encryptionEnabled?: () => boolean }} [deps] - inject tokenCrypto for testability
 * @returns {Array<{name:string,status:string,detail:string}>}
 */
function validateDeployConfig(env = process.env, deps = {}) {
  const out = [];

  // --- Slack OAuth (createReceiver requireEnv's these; missing → boot crash) ---
  for (const key of ["SLACK_SIGNING_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_STATE_SECRET"]) {
    out.push(
      has(env, key)
        ? result(key, "pass", "set")
        : result(key, "fail", "required for the Slack OAuth receiver — the app will not boot without it."),
    );
  }

  // --- Slack scopes (createReceiver throws if neither is set) ---
  out.push(
    has(env, "SLACK_BOT_SCOPES") || has(env, "SLACK_SCOPES")
      ? result("Slack bot scopes", "pass", "SLACK_BOT_SCOPES / SLACK_SCOPES present")
      : result("Slack bot scopes", "fail", "set SLACK_BOT_SCOPES (or SLACK_SCOPES) — the receiver throws otherwise."),
  );

  // --- Database ---
  out.push(
    has(env, "DATABASE_URL")
      ? result("DATABASE_URL", "pass", "set")
      : result("DATABASE_URL", "fail", "required — the installation store and prisma need it."),
  );

  // --- Token encryption at rest (S1) ---
  // encryptionEnabled() THROWS when TOKEN_ENC_KEY is set-but-malformed (Fix 1);
  // returns false when unset (tokens stored in plaintext); true when usable.
  const encEnabled = deps.encryptionEnabled || (() => require("../../../src/install-kit/tokenCrypto").encryptionEnabled());
  try {
    if (encEnabled()) {
      out.push(result("TOKEN_ENC_KEY", "pass", "usable 32-byte key — OAuth tokens encrypted at rest."));
    } else {
      out.push(
        result(
          "TOKEN_ENC_KEY",
          "warn",
          "not set — OAuth tokens are stored in PLAINTEXT. Set with: heroku config:set TOKEN_ENC_KEY=\"$(openssl rand -base64 32)\"",
        ),
      );
    }
  } catch (err) {
    out.push(
      result("TOKEN_ENC_KEY", "fail", `set but malformed: ${err.message}. Fix or unset it (do not deploy with a broken key).`),
    );
  }

  // --- Tableau MCP server (optional but core to the product) ---
  if (!has(env, "TABLEAU_MCP_SERVER")) {
    out.push(result("TABLEAU_MCP_SERVER", "warn", "not set — the Tableau skill is disabled (Slack-only mode)."));
  } else {
    const raw = env.TABLEAU_MCP_SERVER.trim();
    const v = validateUserMcpUrl(raw);
    if (v.ok) {
      out.push(result("TABLEAU_MCP_SERVER", "pass", `valid public https endpoint (${raw}).`));
    } else if (env.TABLEAU_MCP_ALLOW_PRIVATE === "1") {
      out.push(
        result("TABLEAU_MCP_SERVER", "warn", `${v.error}; allowed only because TABLEAU_MCP_ALLOW_PRIVATE=1 (dev/self-host escape hatch).`),
      );
    } else {
      out.push(
        result("TABLEAU_MCP_SERVER", "fail", `${v.error}. Must be https + a public host (SSRF guard), or set TABLEAU_MCP_ALLOW_PRIVATE=1 for a private target.`),
      );
    }
  }

  // --- Public base URL (install link) ---
  out.push(
    has(env, "PUBLIC_BASE_URL")
      ? result("PUBLIC_BASE_URL", "pass", "set — install link available.")
      : result("PUBLIC_BASE_URL", "warn", "not set — the “add to Slack” install link won't be shown."),
  );

  // --- LLM provider ---
  out.push(resolveLlmProviderStatus(env));

  return out;
}

/**
 * Self-test the SSRF host classifier against a fixed vector list so a
 * regression that opens the guard (e.g. a range accidentally dropped) fails the
 * deploy. Read-only, no network.
 *
 * @returns {{name:string,status:string,detail:string}}
 */
function ssrfGuardSelfTest() {
  const mustBlock = [
    "127.0.0.1",
    "localhost",
    "169.254.169.254", // cloud metadata
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "::1",
    "foo.internal",
  ];
  const mustAllow = ["example.com", "example-tableau-mcp.herokuapp.com", "8.8.8.8"];

  const leaked = mustBlock.filter((h) => classifyHost(h).safe === true);
  const broke = mustAllow.filter((h) => classifyHost(h).safe !== true);

  if (leaked.length || broke.length) {
    const parts = [];
    if (leaked.length) parts.push(`SSRF guard FAILED to block: ${leaked.join(", ")}`);
    if (broke.length) parts.push(`SSRF guard wrongly blocked public host(s): ${broke.join(", ")}`);
    return result("SSRF guard", "fail", parts.join("; "));
  }
  return result("SSRF guard", "pass", `blocks ${mustBlock.length} private/metadata vectors, allows public hosts.`);
}

// ---------------------------------------------------------------------------
// Model-drift scoring (golden prompts)
// ---------------------------------------------------------------------------

// getAiResponse swallows provider errors and returns one of these friendly
// fallback strings instead of throwing. A golden drift case must NEVER count
// such a reply as a behavioral pass — it means the LLM call failed, not that
// the model behaved. Any reply containing one of these fragments is scored as a
// hard failure regardless of the case's own checks.
const INFRA_FALLBACK_FRAGMENTS = [
  "isn't configured for AI yet",
  "AI gateway is unavailable",
  "AI service (AWS Bedrock) is unavailable",
  "AI service hit an error",
  "AI service access isn't set up",
  "Something went wrong on my side",
  "I didn't get a clear response",
];

/**
 * Score a reply against a golden case's checks. Uses robust property checks
 * (contains / excludes / length) rather than exact-string equality, because LLM
 * output legitimately varies — we're catching *behavioral* drift and regressions
 * (refusals, injection compliance, dropped grounding), not wording changes.
 *
 * check ∈
 *   { type: "nonEmpty" }
 *   { type: "includesAny", values: [..], label? }   // reply must contain ≥1
 *   { type: "includesAll", values: [..] }            // reply must contain all
 *   { type: "excludesAll", values: [..], label? }    // reply must contain none
 *   { type: "maxLen", value: n } | { type: "minLen", value: n }
 *
 * @param {{id:string, checks:Array<object>}} caseDef
 * @param {string} replyText
 * @returns {{id:string, passed:boolean, failures:string[]}}
 */
function scoreDriftCase(caseDef, replyText) {
  const text = String(replyText || "");
  const lower = text.toLowerCase();
  const failures = [];

  // Guard: an infra-fallback string means the LLM call failed and was swallowed.
  // Fail loudly rather than mis-scoring "the app didn't crash" as good behavior.
  const infra = INFRA_FALLBACK_FRAGMENTS.find((f) => lower.includes(f.toLowerCase()));
  if (infra) {
    return { id: caseDef.id, passed: false, failures: [`LLM call failed (infra fallback returned: "${infra}")`] };
  }

  for (const c of caseDef.checks || []) {
    switch (c.type) {
      case "nonEmpty":
        if (text.trim() === "") failures.push("reply was empty");
        break;
      case "includesAny": {
        const hit = (c.values || []).some((v) => lower.includes(String(v).toLowerCase()));
        if (!hit) failures.push(`${c.label || "expected content"} missing (none of: ${(c.values || []).join(", ")})`);
        break;
      }
      case "includesAll": {
        const miss = (c.values || []).filter((v) => !lower.includes(String(v).toLowerCase()));
        if (miss.length) failures.push(`missing required content: ${miss.join(", ")}`);
        break;
      }
      case "excludesAll": {
        const bad = (c.values || []).filter((v) => lower.includes(String(v).toLowerCase()));
        if (bad.length) failures.push(`${c.label || "forbidden content"} present: ${bad.join(", ")}`);
        break;
      }
      case "maxLen":
        if (text.length > c.value) failures.push(`too long (${text.length} > ${c.value} chars)`);
        break;
      case "minLen":
        if (text.length < c.value) failures.push(`too short (${text.length} < ${c.value} chars)`);
        break;
      default:
        failures.push(`unknown check type: ${c.type}`);
    }
  }
  return { id: caseDef.id, passed: failures.length === 0, failures };
}

/**
 * Score a routing case against classifyIntent output. Deterministic, no network
 * — catches drift in the intent-router regexes as they're edited over time.
 *
 * @param {{message:string, expectIntents?:string[], notIntents?:string[]}} caseDef
 * @param {string[]} actualIntents
 * @returns {{message:string, passed:boolean, failures:string[]}}
 */
function scoreRoutingCase(caseDef, actualIntents) {
  const set = new Set(actualIntents || []);
  const failures = [];
  for (const want of caseDef.expectIntents || []) {
    if (!set.has(want)) failures.push(`expected intent "${want}" not routed (got: ${[...set].join(", ") || "none"})`);
  }
  for (const notWant of caseDef.notIntents || []) {
    if (set.has(notWant)) failures.push(`intent "${notWant}" should NOT have routed`);
  }
  return { message: caseDef.message, passed: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Context-rot analysis (datasource catalog growth)
// ---------------------------------------------------------------------------

/**
 * Analyze how a datasource catalog behaves as it grows: does a known target
 * still rank #1 for a natural-language query, and does it still fit inside the
 * catalog the model actually sees (the display cap)?
 *
 * @param {Array<{name:string,luid:string,project?:string}>} catalog
 * @param {{ query?: string, target?: string, displayCap?: number }} [opts]
 *   target = a datasource name OR luid we expect to be resolvable.
 * @returns {{
 *   total:number, compactChars:number, approxTokens:number, displayCap:number,
 *   shownRows:number, hiddenRows:number, target:object|null, warnings:string[]
 * }}
 */
function analyzeCatalogGrowth(catalog, opts = {}) {
  const displayCap = opts.displayCap || DATASOURCE_DISPLAY_CAP;
  const list = Array.isArray(catalog) ? catalog : [];
  const total = list.length;
  const compact = formatDatasourceCatalogCompact(list, displayCap);
  const compactChars = compact.length;
  const approxTokens = Math.round(compactChars / CHARS_PER_TOKEN);
  const shownRows = Math.min(total, displayCap);
  const hiddenRows = Math.max(0, total - displayCap);
  const warnings = [];

  if (hiddenRows > 0) {
    warnings.push(
      `catalog has ${total} datasources but the model only sees the first ${displayCap}; ` +
        `${hiddenRows} are hidden from "what datasources exist" listings.`,
    );
  }

  let targetInfo = null;
  if (opts.target && opts.query) {
    const t = String(opts.target).toLowerCase();
    const idx = list.findIndex(
      (r) => String(r.luid).toLowerCase() === t || String(r.name).toLowerCase() === t,
    );
    const present = idx >= 0;
    const ranked = rankDatasourcesForMessage(opts.query, list);
    const rank = ranked.findIndex(
      (x) => String(x.row.luid).toLowerCase() === t || String(x.row.name).toLowerCase() === t,
    );
    targetInfo = {
      target: opts.target,
      present,
      catalogIndex: idx,
      shownInCompact: present && idx < displayCap,
      rank: rank >= 0 ? rank + 1 : null, // 1-based; null = not ranked
      topName: ranked[0] ? ranked[0].row.name : null,
      topScore: ranked[0] ? ranked[0].score : 0,
    };

    if (!present) {
      warnings.push(`target "${opts.target}" is NOT in the catalog (renamed, unpublished, or beyond the server list limit?).`);
    } else {
      if (targetInfo.rank === null) {
        warnings.push(`target "${opts.target}" no longer ranks for query "${opts.query}" — matching may have drifted.`);
      } else if (targetInfo.rank > 1) {
        warnings.push(`target "${opts.target}" ranks #${targetInfo.rank} (not #1) for "${opts.query}" — a decoy is now scoring higher.`);
      }
      if (!targetInfo.shownInCompact) {
        warnings.push(
          `target "${opts.target}" sits at catalog index ${idx}, beyond the ${displayCap}-row display cap — it won't appear in the model's catalog listing.`,
        );
      }
    }
  }

  return { total, compactChars, approxTokens, displayCap, shownRows, hiddenRows, target: targetInfo, warnings };
}

module.exports = {
  DATASOURCE_DISPLAY_CAP,
  CHARS_PER_TOKEN,
  INFRA_FALLBACK_FRAGMENTS,
  validateDeployConfig,
  resolveLlmProviderStatus,
  ssrfGuardSelfTest,
  scoreDriftCase,
  scoreRoutingCase,
  analyzeCatalogGrowth,
  // re-exported so the runner uses the same parser the app does
  parseDatasourceCatalog,
};
