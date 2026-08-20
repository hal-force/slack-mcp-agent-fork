const { test } = require("node:test");
const assert = require("node:assert");

const { runSupervised, agentsEnabled } = require("../../src/agents/supervisor");
const { INTENTS } = require("../../src/router/intentRouter");

function withFlag(value, fn) {
  const prev = process.env.AGENTS_ENABLED;
  if (value === null) delete process.env.AGENTS_ENABLED;
  else process.env.AGENTS_ENABLED = value;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ENABLED;
      else process.env.AGENTS_ENABLED = prev;
    }
  })();
}

const SENTINEL = { text: "baseline reply", uploads: [], runSideEffects: async () => [] };
const SPEC_REPLY = { text: "specialist reply", uploads: [], runSideEffects: async () => [] };

test("agentsEnabled parses truthy/falsey forms", () => {
  return withFlag("1", async () => assert.equal(agentsEnabled(), true))
    .then(() => withFlag("true", async () => assert.equal(agentsEnabled(), true)))
    .then(() => withFlag("on", async () => assert.equal(agentsEnabled(), true)))
    .then(() => withFlag("0", async () => assert.equal(agentsEnabled(), false)))
    .then(() => withFlag("", async () => assert.equal(agentsEnabled(), false)))
    .then(() => withFlag(null, async () => assert.equal(agentsEnabled(), false)));
});

test("flag OFF → delegates to getAiResponse with the EXACT aiParams object", () => {
  return withFlag(null, async () => {
    const aiParams = { userMessage: "who should take PT0001?", marker: Symbol("x") };
    let received = null;
    const getAiResponse = async (args) => {
      received = args;
      return SENTINEL;
    };
    const out = await runSupervised(
      { intents: [INTENTS.TRIAGE], aiParams },
      { getAiResponse, triageSpecialist: { run: async () => SPEC_REPLY }, composeTriageReply: () => SPEC_REPLY },
    );
    // Even with a triage intent AND a specialist wired, the flag being off means
    // the specialist must NOT run — pure baseline, same args object.
    assert.strictEqual(out, SENTINEL);
    assert.strictEqual(received, aiParams, "aiParams must be passed through unchanged");
  });
});

test("flag ON + triage intent + specialist → runs specialist, composes reply", () => {
  return withFlag("1", async () => {
    let specCalled = false;
    let composeArgs = null;
    const getAiResponse = async () => SENTINEL;
    const triageSpecialist = {
      run: async ({ intents }) => {
        specCalled = true;
        assert.ok(intents.includes(INTENTS.TRIAGE));
        return { structured: { mode: "analysis" }, text: "…" };
      },
    };
    const composeTriageReply = (specResult, aiParams) => {
      composeArgs = { specResult, aiParams };
      return SPEC_REPLY;
    };
    const aiParams = { userMessage: "does skill match predict outcomes?" };
    const out = await runSupervised(
      { intents: [INTENTS.TRIAGE], aiParams },
      { getAiResponse, triageSpecialist, composeTriageReply },
    );
    assert.equal(specCalled, true);
    assert.strictEqual(out, SPEC_REPLY);
    assert.strictEqual(composeArgs.aiParams, aiParams);
  });
});

test("flag ON + NON-triage intent → baseline even with a specialist present", () => {
  return withFlag("1", async () => {
    let specCalled = false;
    const getAiResponse = async () => SENTINEL;
    const triageSpecialist = { run: async () => { specCalled = true; return {}; } };
    const out = await runSupervised(
      { intents: [INTENTS.TABLEAU], aiParams: {} },
      { getAiResponse, triageSpecialist, composeTriageReply: () => SPEC_REPLY },
    );
    assert.equal(specCalled, false);
    assert.strictEqual(out, SENTINEL);
  });
});

test("flag ON + triage intent but NO specialist wired → baseline", () => {
  return withFlag("1", async () => {
    const getAiResponse = async () => SENTINEL;
    const out = await runSupervised(
      { intents: [INTENTS.TRIAGE], aiParams: {} },
      { getAiResponse },
    );
    assert.strictEqual(out, SENTINEL);
  });
});

test("specialist failure falls back to baseline (never black-holes the turn)", () => {
  return withFlag("1", async () => {
    const getAiResponse = async () => SENTINEL;
    const triageSpecialist = { run: async () => { throw new Error("model exploded"); } };
    const out = await runSupervised(
      { intents: [INTENTS.TRIAGE], aiParams: {} },
      { getAiResponse, triageSpecialist, composeTriageReply: () => SPEC_REPLY },
    );
    assert.strictEqual(out, SENTINEL, "should fall back to baseline on specialist error");
  });
});

test("missing getAiResponse dep throws (programmer error)", async () => {
  await assert.rejects(
    () => runSupervised({ intents: [], aiParams: {} }, {}),
    /getAiResponse is required/,
  );
});
