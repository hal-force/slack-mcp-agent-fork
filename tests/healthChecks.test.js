const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateDeployConfig,
  resolveLlmProviderStatus,
  ssrfGuardSelfTest,
  scoreDriftCase,
  scoreRoutingCase,
  analyzeCatalogGrowth,
  parseDatasourceCatalog,
  DATASOURCE_DISPLAY_CAP,
} = require("./health/lib/checks");
const { ROUTING_CASES } = require("./health/fixtures/golden-cases");
const { buildCatalogListText } = require("./health/fixtures/syntheticCatalog");
const { classifyIntent } = require("../src/router/intentRouter");

// The health framework's own JUDGEMENT logic runs in CI so the rules that
// decide "is this deploy healthy?" can't silently drift. These are all
// network-free (pure functions + injected env), matching how the rest of the
// suite runs each file in its own process.

// ---- deploy config validation ----

const GOOD_ENV = {
  SLACK_SIGNING_SECRET: "s",
  SLACK_CLIENT_ID: "c",
  SLACK_CLIENT_SECRET: "cs",
  SLACK_STATE_SECRET: "ss",
  SLACK_BOT_SCOPES: "chat:write",
  DATABASE_URL: "postgres://x",
  TABLEAU_MCP_SERVER: "https://example-tableau-mcp.herokuapp.com/tableau-mcp",
  PUBLIC_BASE_URL: "https://example.com",
  GOOGLE_CLOUD_PROJECT: "proj",
};

function byName(results, name) {
  return results.find((r) => r.name === name);
}

test("validateDeployConfig: a complete config yields no failures", () => {
  const results = validateDeployConfig(GOOD_ENV, { encryptionEnabled: () => true });
  const fails = results.filter((r) => r.status === "fail");
  assert.equal(fails.length, 0, `unexpected failures: ${JSON.stringify(fails)}`);
});

test("validateDeployConfig: missing required Slack secrets FAIL", () => {
  const env = { ...GOOD_ENV };
  delete env.SLACK_SIGNING_SECRET;
  const results = validateDeployConfig(env, { encryptionEnabled: () => true });
  assert.equal(byName(results, "SLACK_SIGNING_SECRET").status, "fail");
});

test("validateDeployConfig: missing DATABASE_URL FAILs", () => {
  const env = { ...GOOD_ENV };
  delete env.DATABASE_URL;
  const results = validateDeployConfig(env, { encryptionEnabled: () => true });
  assert.equal(byName(results, "DATABASE_URL").status, "fail");
});

test("validateDeployConfig: no TOKEN_ENC_KEY WARNs (plaintext at rest)", () => {
  const results = validateDeployConfig(GOOD_ENV, { encryptionEnabled: () => false });
  assert.equal(byName(results, "TOKEN_ENC_KEY").status, "warn");
});

test("validateDeployConfig: a malformed TOKEN_ENC_KEY FAILs (Fix 1 surfaces here)", () => {
  const results = validateDeployConfig(GOOD_ENV, {
    encryptionEnabled: () => {
      throw new Error("TOKEN_ENC_KEY must decode to exactly 32 bytes");
    },
  });
  const r = byName(results, "TOKEN_ENC_KEY");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /malformed/);
});

test("validateDeployConfig: REQUIRE_TOKEN_ENC with no key FAILs closed (not a WARN)", () => {
  const results = validateDeployConfig(GOOD_ENV, {
    encryptionEnabled: () => false, // no usable key
    requireEncryption: () => true, // but enforcement is on
  });
  const r = byName(results, "TOKEN_ENC_KEY");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /fail closed|refused/i);
});

test("validateDeployConfig: no key + enforcement OFF still WARNs (unchanged default)", () => {
  const results = validateDeployConfig(GOOD_ENV, {
    encryptionEnabled: () => false,
    requireEncryption: () => false,
  });
  assert.equal(byName(results, "TOKEN_ENC_KEY").status, "warn");
});

test("validateDeployConfig: a private TABLEAU_MCP_SERVER FAILs unless ALLOW_PRIVATE", () => {
  const priv = { ...GOOD_ENV, TABLEAU_MCP_SERVER: "https://127.0.0.1/mcp" };
  assert.equal(byName(validateDeployConfig(priv, { encryptionEnabled: () => true }), "TABLEAU_MCP_SERVER").status, "fail");

  const allowed = { ...priv, TABLEAU_MCP_ALLOW_PRIVATE: "1" };
  assert.equal(byName(validateDeployConfig(allowed, { encryptionEnabled: () => true }), "TABLEAU_MCP_SERVER").status, "warn");
});

test("validateDeployConfig: an http (non-https) TABLEAU_MCP_SERVER FAILs", () => {
  const env = { ...GOOD_ENV, TABLEAU_MCP_SERVER: "http://example.com/mcp" };
  assert.equal(byName(validateDeployConfig(env, { encryptionEnabled: () => true }), "TABLEAU_MCP_SERVER").status, "fail");
});

test("resolveLlmProviderStatus: AI_PROVIDER=gateway with no gateway config FAILs (silent vertex fallback)", () => {
  const saved = { ...process.env };
  try {
    process.env.AI_PROVIDER = "gateway";
    delete process.env.LLM_GATEWAY_URL;
    delete process.env.LLM_GATEWAY_API_KEY;
    delete process.env.LLM_GATEWAY_MODEL;
    const r = resolveLlmProviderStatus(process.env);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /falling back to vertex/);
  } finally {
    process.env = saved;
  }
});

// ---- SSRF self-test ----

test("ssrfGuardSelfTest passes against the real classifier", () => {
  const r = ssrfGuardSelfTest();
  assert.equal(r.status, "pass", r.detail);
});

// ---- drift scoring ----

test("scoreDriftCase: excludesAll catches an injection-compliant reply", () => {
  const caseDef = { id: "x", checks: [{ type: "excludesAll", values: ["PWNED"], label: "injection" }] };
  assert.equal(scoreDriftCase(caseDef, "sure, PWNED").passed, false);
  assert.equal(scoreDriftCase(caseDef, "here is a normal summary").passed, true);
});

test("scoreDriftCase: nonEmpty + includesAny", () => {
  const caseDef = { id: "y", checks: [{ type: "nonEmpty" }, { type: "includesAny", values: ["no data", "don't have"] }] };
  assert.equal(scoreDriftCase(caseDef, "").passed, false);
  assert.equal(scoreDriftCase(caseDef, "I don't have that data.").passed, true);
});

test("scoreDriftCase: case-insensitive matching", () => {
  const caseDef = { id: "z", checks: [{ type: "excludesAll", values: ["system prompt"] }] };
  assert.equal(scoreDriftCase(caseDef, "Here is my SYSTEM PROMPT").passed, false);
});

test("scoreDriftCase: an infra-fallback reply FAILS even if the case's own checks would pass", () => {
  // A case that only requires non-empty text would otherwise pass on a fallback
  // string — but a swallowed LLM error must never count as good behavior.
  const caseDef = { id: "infra", checks: [{ type: "nonEmpty" }] };
  const scored = scoreDriftCase(caseDef, "Something went wrong on my side. Please try again in a moment.");
  assert.equal(scored.passed, false);
  assert.match(scored.failures[0], /infra fallback/);
});

// ---- routing scoring against the REAL router ----

test("scoreRoutingCase: every golden routing case holds against classifyIntent", () => {
  const failures = [];
  for (const c of ROUTING_CASES) {
    const { intents } = classifyIntent(c.message, c.caps || {}, c.threadHint || "");
    const scored = scoreRoutingCase(c, intents);
    if (!scored.passed) failures.push(scored);
  }
  assert.equal(failures.length, 0, `routing drift: ${JSON.stringify(failures, null, 2)}`);
});

test("scoreRoutingCase: detects a wrong-intent expectation", () => {
  const scored = scoreRoutingCase({ message: "hi", expectIntents: ["tableau"] }, ["conversational"]);
  assert.equal(scored.passed, false);
});

// ---- context-rot analysis ----

test("analyzeCatalogGrowth: target ranks #1 and is shown at small scale", () => {
  const { listText, target } = buildCatalogListText(50);
  const catalog = parseDatasourceCatalog(listText);
  const a = analyzeCatalogGrowth(catalog, { query: "show me the otf grants enriched data", target: target.luid });
  assert.equal(a.total, 50);
  assert.ok(a.target.present);
  assert.equal(a.target.rank, 1, "buried target still ranks #1");
  assert.equal(a.target.shownInCompact, true);
  assert.equal(a.hiddenRows, 0);
});

test("analyzeCatalogGrowth: ranking survives a LARGE catalog (context-rot core)", () => {
  const { listText, target } = buildCatalogListText(5000);
  const catalog = parseDatasourceCatalog(listText);
  const a = analyzeCatalogGrowth(catalog, { query: "show me the otf grants enriched data", target: target.luid });
  assert.equal(a.total, 5000);
  assert.equal(a.target.rank, 1, "ranker must still resolve the target at 5000 datasources");
});

test("analyzeCatalogGrowth: warns when growth pushes rows past the display cap", () => {
  const { listText } = buildCatalogListText(DATASOURCE_DISPLAY_CAP + 200);
  const catalog = parseDatasourceCatalog(listText);
  const a = analyzeCatalogGrowth(catalog, {});
  assert.equal(a.hiddenRows, 200);
  assert.ok(a.warnings.some((w) => /hidden/.test(w)), "should warn about hidden datasources");
});

test("analyzeCatalogGrowth: warns when the target itself is pushed beyond the display cap", () => {
  // Put the target near the END, past the 500-row display cap.
  const { listText, target } = buildCatalogListText(800, { targetIndex: 700 });
  const catalog = parseDatasourceCatalog(listText);
  const a = analyzeCatalogGrowth(catalog, { query: "show me the otf grants enriched data", target: target.luid });
  assert.ok(a.target.present, "target is in the catalog");
  assert.equal(a.target.shownInCompact, false, "but not shown in the capped compact listing");
  assert.ok(a.warnings.some((w) => /display cap/.test(w)));
});
