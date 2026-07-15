const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  selectedProvider,
  gatewayConfig,
  contentsToOpenAiMessages,
} = require("../src/assistant/llmProvider");

const GW_KEYS = ["AI_PROVIDER", "LLM_GATEWAY_URL", "LLM_GATEWAY_API_KEY", "LLM_GATEWAY_MODEL"];
afterEach(() => {
  for (const k of GW_KEYS) delete process.env[k];
});

function configureGateway() {
  process.env.LLM_GATEWAY_URL = "https://gw/v1/chat/completions";
  process.env.LLM_GATEWAY_API_KEY = "sk-test";
  process.env.LLM_GATEWAY_MODEL = "claude-sonnet-4-6";
}

test("defaults to vertex when AI_PROVIDER unset", () => {
  assert.equal(selectedProvider(), "vertex");
});

test("falls back to vertex when gateway requested but not configured", () => {
  process.env.AI_PROVIDER = "gateway";
  assert.equal(selectedProvider(), "vertex");
  assert.equal(gatewayConfig(), null);
});

test("uses gateway when requested and fully configured", () => {
  process.env.AI_PROVIDER = "gateway";
  configureGateway();
  assert.equal(selectedProvider(), "gateway");
  assert.equal(gatewayConfig().model, "claude-sonnet-4-6");
});

test("gatewayConfig requires all three vars", () => {
  process.env.LLM_GATEWAY_URL = "https://gw";
  process.env.LLM_GATEWAY_API_KEY = "sk-test";
  // model missing
  assert.equal(gatewayConfig(), null);
});

test("contentsToOpenAiMessages maps roles and prepends system", () => {
  const msgs = contentsToOpenAiMessages("SYS", [
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ text: "yo" }] },
  ]);
  assert.deepEqual(msgs, [
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "yo" },
  ]);
});

test("contentsToOpenAiMessages skips empty parts and omits blank system", () => {
  const msgs = contentsToOpenAiMessages("", [
    { role: "user", parts: [{ text: "" }] },
    { role: "user", parts: [{ text: "real" }] },
  ]);
  assert.deepEqual(msgs, [{ role: "user", content: "real" }]);
});
