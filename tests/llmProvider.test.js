const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  selectedProvider,
  gatewayConfig,
  bedrockConfig,
  contentsToOpenAiMessages,
  contentsToBedrockMessages,
} = require("../src/assistant/llmProvider");

const GW_KEYS = ["AI_PROVIDER", "LLM_GATEWAY_URL", "LLM_GATEWAY_API_KEY", "LLM_GATEWAY_MODEL"];
const BEDROCK_KEYS = [
  "BEDROCK_MODEL_ID",
  "BEDROCK_REGION",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
];
// Snapshot AWS_* so we can restore anything the host environment had set.
const AWS_SNAPSHOT = Object.fromEntries(BEDROCK_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of GW_KEYS) delete process.env[k];
  for (const k of BEDROCK_KEYS) {
    if (AWS_SNAPSHOT[k] === undefined) delete process.env[k];
    else process.env[k] = AWS_SNAPSHOT[k];
  }
});

function configureGateway() {
  process.env.LLM_GATEWAY_URL = "https://gw/v1/chat/completions";
  process.env.LLM_GATEWAY_API_KEY = "sk-test";
  process.env.LLM_GATEWAY_MODEL = "claude-sonnet-4-6";
}

function configureBedrock() {
  process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-20250514-v1:0";
  process.env.BEDROCK_REGION = "us-west-2";
  process.env.AWS_ACCESS_KEY_ID = "ASIATEST";
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

// ----- Bedrock -----

test("selects bedrock when requested and fully configured", () => {
  process.env.AI_PROVIDER = "bedrock";
  configureBedrock();
  assert.equal(selectedProvider(), "bedrock");
  assert.equal(bedrockConfig().region, "us-west-2");
});

test("falls back to vertex when bedrock requested but not configured", () => {
  process.env.AI_PROVIDER = "bedrock";
  // no model / creds set (and any host AWS_* were cleared by afterEach of prior test)
  for (const k of BEDROCK_KEYS) delete process.env[k];
  assert.equal(selectedProvider(), "vertex");
  assert.equal(bedrockConfig(), null);
});

test("bedrockConfig requires model, region, and credentials", () => {
  process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-20250514-v1:0";
  process.env.BEDROCK_REGION = "us-west-2";
  delete process.env.AWS_ACCESS_KEY_ID; // no creds
  assert.equal(bedrockConfig(), null);
});

test("bedrockConfig falls back to AWS_REGION when BEDROCK_REGION unset", () => {
  process.env.BEDROCK_MODEL_ID = "model-x";
  delete process.env.BEDROCK_REGION;
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "ASIATEST";
  assert.equal(bedrockConfig().region, "us-east-1");
});

test("contentsToBedrockMessages maps roles, drops empties, merges same-role turns", () => {
  const msgs = contentsToBedrockMessages([
    { role: "user", parts: [{ text: "hi" }] },
    { role: "user", parts: [{ text: "" }] },
    { role: "user", parts: [{ text: "again" }] },
    { role: "model", parts: [{ text: "yo" }] },
  ]);
  assert.deepEqual(msgs, [
    { role: "user", content: [{ text: "hi" }, { text: "again" }] },
    { role: "assistant", content: [{ text: "yo" }] },
  ]);
});
