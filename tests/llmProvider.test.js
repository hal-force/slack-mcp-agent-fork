const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  selectedProvider,
  gatewayConfig,
  bedrockConfig,
  contentsToOpenAiMessages,
  contentsToBedrockMessages,
  toolSpecsToConverseToolConfig,
  generateWithBedrock,
} = require("../src/assistant/llmProvider");

const GW_KEYS = ["AI_PROVIDER", "LLM_GATEWAY_URL", "LLM_GATEWAY_API_KEY", "LLM_GATEWAY_MODEL"];
const BEDROCK_KEYS = [
  "BEDROCK_MODEL_ID",
  "BEDROCK_REGION",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  // Role-based credential sources bedrockConfig() also honors. Listed here so
  // the suite clears any host value (CI on ECS/App Runner sets the container
  // creds URI) and restores it after — otherwise the "unconfigured" cases
  // would spuriously detect creds.
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
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
  delete process.env.AWS_ACCESS_KEY_ID; // no SigV4 creds
  delete process.env.AWS_BEARER_TOKEN_BEDROCK; // and no bearer token
  assert.equal(bedrockConfig(), null);
});

test("bedrockConfig accepts a bearer token as credentials (no access key)", () => {
  process.env.AI_PROVIDER = "bedrock";
  process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-20250514-v1:0";
  process.env.BEDROCK_REGION = "us-west-2";
  delete process.env.AWS_ACCESS_KEY_ID; // long-term API key path, no SigV4 keys
  process.env.AWS_BEARER_TOKEN_BEDROCK = "ABSK-test-token";
  assert.equal(selectedProvider(), "bedrock");
  assert.equal(bedrockConfig().region, "us-west-2");
});

test("bedrockConfig accepts an App Runner / ECS instance role (no static keys)", () => {
  // The recommended AWS deploy sets NO key env vars — creds come from the
  // container credentials endpoint. Regression guard for the deploy gate that
  // previously failed here and fell back to vertex.
  process.env.AI_PROVIDER = "bedrock";
  process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-5";
  process.env.BEDROCK_REGION = "us-west-2";
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/abc123";
  assert.equal(selectedProvider(), "bedrock");
  assert.equal(bedrockConfig().region, "us-west-2");
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

// ----- Bedrock tool-use (Converse) -----

test("toolSpecsToConverseToolConfig wraps specs as { toolSpec: { inputSchema: { json } } }", () => {
  assert.equal(toolSpecsToConverseToolConfig([]), undefined);
  assert.equal(toolSpecsToConverseToolConfig(undefined), undefined);
  const cfg = toolSpecsToConverseToolConfig([
    { name: "t1", description: "d", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
  ]);
  assert.equal(cfg.tools.length, 1);
  assert.equal(cfg.tools[0].toolSpec.name, "t1");
  assert.equal(cfg.tools[0].toolSpec.description, "d");
  assert.deepEqual(cfg.tools[0].toolSpec.inputSchema.json, {
    type: "object",
    properties: { x: { type: "string" } },
  });
});

test("generateWithBedrock runs the tool loop: services tool_use, feeds results, returns final text", async () => {
  process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-6";
  process.env.BEDROCK_REGION = "us-west-2";
  process.env.AWS_ACCESS_KEY_ID = "ASIATEST";

  const sent = []; // capture each ConverseCommand input
  // Fake client: first call asks for a tool, second call returns the final answer.
  let call = 0;
  const fakeClient = {
    async send(cmd) {
      sent.push(cmd.input);
      call += 1;
      if (call === 1) {
        return {
          stopReason: "tool_use",
          output: {
            message: {
              role: "assistant",
              content: [
                { text: "Let me check that." },
                {
                  toolUse: {
                    toolUseId: "tu-1",
                    name: "tableau_get_datasource_metadata",
                    input: { datasource_luid: "abc" },
                  },
                },
              ],
            },
          },
        };
      }
      return {
        stopReason: "end_turn",
        output: { message: { role: "assistant", content: [{ text: "Final answer: 42 grants." }] } },
      };
    },
  };

  const dispatched = [];
  const result = await generateWithBedrock({
    systemInstruction: "sys",
    contents: [{ role: "user", parts: [{ text: "how many grants?" }] }],
    maxOutputTokens: 1024,
    temperature: 0.7,
    tools: [
      {
        name: "tableau_get_datasource_metadata",
        description: "meta",
        inputSchema: { type: "object", properties: { datasource_luid: { type: "string" } } },
      },
    ],
    dispatchTool: async (name, input) => {
      dispatched.push({ name, input });
      return { ok: true, content: "fields: Grant Amount, Recipient" };
    },
    __client: fakeClient,
  });

  // The model's tool request was dispatched with the given args.
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].name, "tableau_get_datasource_metadata");
  assert.deepEqual(dispatched[0].input, { datasource_luid: "abc" });

  // Two Converse round-trips; the second included a user turn carrying the toolResult.
  assert.equal(sent.length, 2);
  const secondMsgs = sent[1].messages;
  const toolResultTurn = secondMsgs.find(
    (m) => m.role === "user" && (m.content || []).some((c) => c.toolResult),
  );
  assert.ok(toolResultTurn, "second request should include a toolResult user turn");
  const tr = toolResultTurn.content.find((c) => c.toolResult).toolResult;
  assert.equal(tr.toolUseId, "tu-1");
  assert.equal(tr.status, "success");
  assert.deepEqual(tr.content[0].json, { ok: true, content: "fields: Grant Amount, Recipient" });

  // Final text is the model's last message.
  assert.equal(result.text, "Final answer: 42 grants.");
  assert.equal(result.finishReason, "end_turn");
});

test("generateWithBedrock marks a failed tool result with status error", async () => {
  process.env.BEDROCK_MODEL_ID = "m";
  process.env.BEDROCK_REGION = "us-west-2";
  process.env.AWS_ACCESS_KEY_ID = "ASIATEST";

  const sent = [];
  let call = 0;
  const fakeClient = {
    async send(cmd) {
      sent.push(cmd.input);
      call += 1;
      if (call === 1) {
        return {
          stopReason: "tool_use",
          output: {
            message: {
              role: "assistant",
              content: [{ toolUse: { toolUseId: "tu-x", name: "tableau_query_datasource", input: {} } }],
            },
          },
        };
      }
      return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "ok" }] } } };
    },
  };

  await generateWithBedrock({
    systemInstruction: "",
    contents: [{ role: "user", parts: [{ text: "q" }] }],
    maxOutputTokens: 256,
    temperature: 0,
    tools: [{ name: "tableau_query_datasource", description: "q", inputSchema: { type: "object", properties: {} } }],
    dispatchTool: async () => ({ ok: false, error: "boom" }),
    __client: fakeClient,
  });

  const tr = sent[1].messages
    .flatMap((m) => m.content || [])
    .find((c) => c.toolResult).toolResult;
  assert.equal(tr.status, "error");
  assert.deepEqual(tr.content[0].json, { ok: false, error: "boom" });
});

test("generateWithBedrock safety valve keeps toolConfig defined at the round cap (no toolConfig-undefined crash)", async (t) => {
  process.env.BEDROCK_MODEL_ID = "m";
  process.env.BEDROCK_REGION = "us-west-2";
  process.env.AWS_ACCESS_KEY_ID = "ASIATEST";
  process.env.BEDROCK_MAX_TOOL_ROUNDS = "2"; // small cap so the valve trips fast
  t.after(() => { delete process.env.BEDROCK_MAX_TOOL_ROUNDS; });

  const sent = [];
  const fakeClient = {
    async send(cmd) {
      sent.push(cmd.input);
      // Always ask for a tool → forces the loop to burn rounds and hit the valve.
      return {
        stopReason: "tool_use",
        output: {
          message: {
            role: "assistant",
            content: [{ toolUse: { toolUseId: `tu-${sent.length}`, name: "tableau_query_datasource", input: {} } }],
          },
        },
      };
    },
  };

  const result = await generateWithBedrock({
    systemInstruction: "sys",
    contents: [{ role: "user", parts: [{ text: "loop please" }] }],
    maxOutputTokens: 256,
    temperature: 0,
    tools: [{ name: "tableau_query_datasource", description: "q", inputSchema: { type: "object", properties: {} } }],
    dispatchTool: async () => ({ ok: false, error: "timeout" }), // tool keeps failing
    __client: fakeClient,
  });

  // The final (valve) request must STILL carry toolConfig — Bedrock rejects an
  // undefined toolConfig once the history has toolUse/toolResult blocks.
  const last = sent[sent.length - 1];
  assert.ok(last.toolConfig, "safety-valve request must keep toolConfig defined");
  assert.ok(last.toolConfig.tools.length >= 1);
  // And it must include the plain-text "final answer now" nudge as the last user turn.
  const lastUserTurn = [...last.messages].reverse().find((m) => m.role === "user");
  assert.ok(
    (lastUserTurn.content || []).some((c) => c.text && /final answer now/i.test(c.text)),
    "valve should nudge the model for a final answer",
  );
  assert.equal(result.finishReason, "tool_use"); // we broke out at the cap
});

test("generateWithBedrock without tools makes exactly one call (unchanged path)", async () => {
  process.env.BEDROCK_MODEL_ID = "m";
  process.env.BEDROCK_REGION = "us-west-2";
  process.env.AWS_ACCESS_KEY_ID = "ASIATEST";

  let calls = 0;
  const fakeClient = {
    async send() {
      calls += 1;
      return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "hi" }] } } };
    },
  };
  const result = await generateWithBedrock({
    systemInstruction: "",
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    maxOutputTokens: 128,
    temperature: 0.7,
    __client: fakeClient,
  });
  assert.equal(calls, 1);
  assert.equal(result.text, "hi");
});

test("generateWithBedrock retries without temperature when the model rejects it", async () => {
  process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-5";
  process.env.BEDROCK_REGION = "us-west-2";
  process.env.AWS_ACCESS_KEY_ID = "ASIATEST";

  const sent = [];
  let call = 0;
  const fakeClient = {
    async send(cmd) {
      sent.push(cmd.input);
      call += 1;
      // First attempt (with temperature) is rejected exactly like Sonnet 5 does.
      if (call === 1) {
        const err = new Error("The model returned the following errors: `temperature` is deprecated for this model.");
        err.name = "ValidationException";
        throw err;
      }
      return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "recovered" }] } } };
    },
  };

  const result = await generateWithBedrock({
    systemInstruction: "sys",
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    maxOutputTokens: 128,
    temperature: 0.7,
    __client: fakeClient,
  });

  // Two calls: the rejected one and the temperature-stripped retry.
  assert.equal(sent.length, 2);
  assert.equal(sent[0].inferenceConfig.temperature, 0.7, "first attempt includes temperature");
  assert.equal(sent[1].inferenceConfig.temperature, undefined, "retry omits temperature");
  assert.equal(result.text, "recovered");
});

test("generateWithBedrock omits temperature when not a finite number", async () => {
  process.env.BEDROCK_MODEL_ID = "m";
  process.env.BEDROCK_REGION = "us-west-2";
  process.env.AWS_ACCESS_KEY_ID = "ASIATEST";

  const sent = [];
  const fakeClient = {
    async send(cmd) {
      sent.push(cmd.input);
      return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "ok" }] } } };
    },
  };
  await generateWithBedrock({
    systemInstruction: "",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    maxOutputTokens: 64,
    temperature: undefined,
    __client: fakeClient,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].inferenceConfig.temperature, undefined);
  assert.equal(sent[0].inferenceConfig.maxTokens, 64);
});
