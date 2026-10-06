const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { getAiResponse } = require("../src/assistant/respond");

const KEYS = ["AI_PROVIDER", "COHERE_API_KEY", "COHERE_MODEL_ID"];
const SNAPSHOT = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  for (const k of KEYS) {
    if (SNAPSHOT[k] === undefined) delete process.env[k];
    else process.env[k] = SNAPSHOT[k];
  }
});

function cohereFailsWith(status, body) {
  process.env.AI_PROVIDER = "cohere";
  process.env.COHERE_API_KEY = "co-test-key";
  process.env.COHERE_MODEL_ID = "command-a-plus-05-2026";
  global.fetch = async () => ({ ok: false, status, async text() { return body; } });
}

test("a Cohere error mentioning 'credential' is not blamed on AWS Bedrock", async (t) => {
  t.mock.method(console, "error", () => {});
  cohereFailsWith(500, "upstream credential cache unavailable");
  const reply = await getAiResponse({ userMessage: "hi", threadHistory: [] });
  assert.doesNotMatch(reply.text, /Bedrock|AWS/);
  assert.match(reply.text, /hit an error/);
});

test("a Cohere 401 still reports the rejected API key", async (t) => {
  t.mock.method(console, "error", () => {});
  cohereFailsWith(401, "invalid api token");
  const reply = await getAiResponse({ userMessage: "hi", threadHistory: [] });
  assert.match(reply.text, /Cohere\) rejected its API key/);
});
