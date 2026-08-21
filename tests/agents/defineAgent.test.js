const { test } = require("node:test");
const assert = require("node:assert");

const { extractStructured } = require("../../src/agents/defineAgent");
const { generateWithBedrock } = require("../../src/assistant/llmProvider");

// ---- extractStructured: the structured-output contract ----

test("extracts a trailing ```json block and strips it from prose", () => {
  const text = "Here is my analysis.\n\n```json\n{\"mode\":\"analysis\",\"findings\":[]}\n```";
  const { structured, cleanedText } = extractStructured(text);
  assert.deepEqual(structured, { mode: "analysis", findings: [] });
  assert.equal(cleanedText, "Here is my analysis.");
});

test("picks the LAST json block when several are present", () => {
  const text = "```json\n{\"a\":1}\n```\nmiddle\n```json\n{\"b\":2}\n```";
  const { structured } = extractStructured(text);
  assert.deepEqual(structured, { b: 2 });
});

test("bare ``` fence with a JSON body still parses", () => {
  const text = "prose\n```\n{\"ok\":true}\n```";
  const { structured } = extractStructured(text);
  assert.deepEqual(structured, { ok: true });
});

test("malformed JSON → structured null, prose untouched (never throws)", () => {
  const text = "answer\n```json\n{ not: valid, json }\n```";
  const { structured, cleanedText } = extractStructured(text);
  assert.equal(structured, null);
  assert.equal(cleanedText, text);
});

test("no json block → structured null, cleanedText == input", () => {
  const text = "just prose, no structure here";
  const { structured, cleanedText } = extractStructured(text);
  assert.equal(structured, null);
  assert.equal(cleanedText, text);
});

test("recovers structured output from a truncated response missing its closing fence", () => {
  // Simulates a max_tokens cutoff: the model emitted the whole JSON body but the
  // run ended before the closing ```. The complete body must still parse.
  const text = "Here is the plan.\n\n```json\n{\"mode\":\"plan\",\"steps\":[1,2,3]}";
  const { structured, cleanedText } = extractStructured(text);
  assert.deepEqual(structured, { mode: "plan", steps: [1, 2, 3] });
  assert.equal(cleanedText, "Here is the plan.");
});

test("a truly truncated JSON body (severed mid-object) still yields null, not a throw", () => {
  const text = "prose\n```json\n{\"a\":1,\"b\":";
  const { structured, cleanedText } = extractStructured(text);
  assert.equal(structured, null);
  assert.equal(cleanedText, text);
});

test("a closed fence is still preferred over any trailing open fence", () => {
  const text = "```json\n{\"a\":1}\n```\ntail ```json\n{\"b\":2}";
  const { structured } = extractStructured(text);
  // The closed block wins (matched by the primary regex); the open one is only a
  // fallback when NO closed block exists.
  assert.deepEqual(structured, { a: 1 });
});

test("a ```json block containing a non-object (string) is ignored", () => {
  const text = "x\n```json\n\"hello\"\n```";
  const { structured } = extractStructured(text);
  // Body doesn't start with { or [ → not treated as structured output.
  assert.equal(structured, null);
});

test("empty / non-string input is safe", () => {
  assert.deepEqual(extractStructured(""), { structured: null, cleanedText: "" });
  assert.deepEqual(extractStructured(null), { structured: null, cleanedText: "" });
});

// ---- Bedrock per-agent model pin (bedrockModelId) ----
// Uses the __client test seam. Confirms the override reaches the ConverseCommand
// and that the baseline (no override) still uses the configured model.

function fakeBedrockEnv(t) {
  const keys = ["BEDROCK_MODEL_ID", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.BEDROCK_MODEL_ID = "app-default-model";
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token";
  t.after(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

/** A fake Converse client that records the modelId it was called with. */
function recordingClient(captured) {
  return {
    send: async (command) => {
      captured.push(command.input.modelId);
      return {
        stopReason: "end_turn",
        output: { message: { role: "assistant", content: [{ text: "ok" }] } },
      };
    },
  };
}

test("bedrockModelId overrides the configured model for this call", async (t) => {
  fakeBedrockEnv(t);
  const captured = [];
  await generateWithBedrock({
    systemInstruction: "role",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    maxOutputTokens: 100,
    bedrockModelId: "pinned-sonnet-5",
    __client: recordingClient(captured),
  });
  assert.deepEqual(captured, ["pinned-sonnet-5"]);
});

test("no bedrockModelId → falls back to configured BEDROCK_MODEL_ID (baseline unchanged)", async (t) => {
  fakeBedrockEnv(t);
  const captured = [];
  await generateWithBedrock({
    systemInstruction: "role",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    maxOutputTokens: 100,
    __client: recordingClient(captured),
  });
  assert.deepEqual(captured, ["app-default-model"]);
});

test("blank bedrockModelId is treated as unset (uses configured model)", async (t) => {
  fakeBedrockEnv(t);
  const captured = [];
  await generateWithBedrock({
    systemInstruction: "role",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    maxOutputTokens: 100,
    bedrockModelId: "   ",
    __client: recordingClient(captured),
  });
  assert.deepEqual(captured, ["app-default-model"]);
});
