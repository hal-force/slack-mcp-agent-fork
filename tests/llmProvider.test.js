const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  selectedProvider,
  defaultMaxOutputTokens,
  gatewayConfig,
  gatewayAuthMode,
  bedrockConfig,
  cohereConfig,
  contentsToOpenAiMessages,
  contentsToBedrockMessages,
  toolSpecsToConverseToolConfig,
  toolSpecsToCohereTools,
  generateWithBedrock,
  generateWithCohere,
  generateWithGateway,
  gatewayAuthHeaders,
  getAzureAccessToken,
  _resetAzureTokenCache,
} = require("../src/assistant/llmProvider");

const GW_KEYS = ["AI_PROVIDER", "LLM_GATEWAY_URL", "LLM_GATEWAY_API_KEY", "LLM_GATEWAY_MODEL", "LLM_GATEWAY_AUTH"];
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
const COHERE_KEYS = ["COHERE_API_KEY", "COHERE_MODEL_ID", "COHERE_BASE_URL", "COHERE_MAX_TOOL_ROUNDS"];
const TOKEN_KEYS = ["LLM_MAX_OUTPUT_TOKENS", "GEMINI_MAX_OUTPUT_TOKENS"];
// Snapshot AWS_* so we can restore anything the host environment had set.
const AWS_SNAPSHOT = Object.fromEntries(BEDROCK_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of GW_KEYS) delete process.env[k];
  for (const k of COHERE_KEYS) delete process.env[k];
  for (const k of TOKEN_KEYS) delete process.env[k];
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

function configureCohere() {
  process.env.COHERE_API_KEY = "co-test-key";
  process.env.COHERE_MODEL_ID = "command-a-plus-05-2026";
}

// ----- defaultMaxOutputTokens -----

test("defaultMaxOutputTokens is 4096 on non-Cohere providers", () => {
  for (const k of TOKEN_KEYS) delete process.env[k];
  assert.equal(defaultMaxOutputTokens(), 4096); // vertex
  process.env.AI_PROVIDER = "bedrock";
  configureBedrock();
  assert.equal(defaultMaxOutputTokens(), 4096);
});

test("defaultMaxOutputTokens is 8192 on Cohere so thinking can't starve the answer", () => {
  for (const k of TOKEN_KEYS) delete process.env[k];
  process.env.AI_PROVIDER = "cohere";
  configureCohere();
  assert.equal(defaultMaxOutputTokens(), 8192);
});

test("defaultMaxOutputTokens: Cohere requested but unconfigured falls back with vertex", () => {
  for (const k of TOKEN_KEYS) delete process.env[k];
  process.env.AI_PROVIDER = "cohere"; // no key/model → selectedProvider() is vertex
  assert.equal(defaultMaxOutputTokens(), 4096);
});

test("defaultMaxOutputTokens: LLM_MAX_OUTPUT_TOKENS (then GEMINI_*) always wins", () => {
  process.env.AI_PROVIDER = "cohere";
  configureCohere();
  process.env.GEMINI_MAX_OUTPUT_TOKENS = "2048";
  assert.equal(defaultMaxOutputTokens(), 2048);
  process.env.LLM_MAX_OUTPUT_TOKENS = "64000";
  assert.equal(defaultMaxOutputTokens(), 64000);
});

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

// ----- Cohere -----

test("selects cohere when requested and fully configured", () => {
  process.env.AI_PROVIDER = "cohere";
  configureCohere();
  assert.equal(selectedProvider(), "cohere");
  assert.equal(cohereConfig().model, "command-a-plus-05-2026");
  assert.equal(cohereConfig().baseUrl, "https://api.cohere.com");
});

test("falls back to vertex when cohere requested but not configured", () => {
  process.env.AI_PROVIDER = "cohere";
  process.env.COHERE_API_KEY = "co-test-key"; // model missing
  assert.equal(selectedProvider(), "vertex");
  assert.equal(cohereConfig(), null);
});

test("cohereConfig requires both an api key and a model", () => {
  process.env.COHERE_MODEL_ID = "command-a-plus-05-2026"; // no key
  assert.equal(cohereConfig(), null);
  process.env.COHERE_API_KEY = "co-test-key";
  assert.ok(cohereConfig());
});

test("cohereConfig honors COHERE_BASE_URL and strips a trailing slash", () => {
  configureCohere();
  process.env.COHERE_BASE_URL = "https://cohere.internal.example.com/";
  assert.equal(cohereConfig().baseUrl, "https://cohere.internal.example.com");
});

test("toolSpecsToCohereTools wraps specs as { type:'function', function:{ parameters } }", () => {
  assert.equal(toolSpecsToCohereTools([]), undefined);
  assert.equal(toolSpecsToCohereTools(undefined), undefined);
  const cohereTools = toolSpecsToCohereTools([
    { name: "t1", description: "d", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
  ]);
  assert.equal(cohereTools.length, 1);
  assert.equal(cohereTools[0].type, "function");
  assert.equal(cohereTools[0].function.name, "t1");
  assert.equal(cohereTools[0].function.description, "d");
  assert.deepEqual(cohereTools[0].function.parameters, {
    type: "object",
    properties: { x: { type: "string" } },
  });
});

test("generateWithCohere runs the tool loop: services TOOL_CALL, feeds a tool message, returns final text", async (t) => {
  configureCohere();

  const sent = []; // parsed request bodies
  let captured = null;
  let call = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    captured = { url, init };
    sent.push(JSON.parse(init.body));
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            finish_reason: "TOOL_CALL",
            message: {
              role: "assistant",
              tool_plan: "I'll pull the datasource metadata.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "tableau_get_datasource_metadata",
                    arguments: JSON.stringify({ datasource_luid: "abc" }),
                  },
                },
              ],
            },
          });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          finish_reason: "COMPLETE",
          message: { role: "assistant", content: [{ type: "text", text: "Final answer: 42 grants." }] },
        });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; });

  const dispatched = [];
  const result = await generateWithCohere({
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
  });

  // Hits the v2 chat endpoint with a Bearer key.
  assert.equal(captured.url, "https://api.cohere.com/v2/chat");
  assert.equal(captured.init.headers.Authorization, "Bearer co-test-key");

  // The tool request was dispatched with the parsed args.
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].name, "tableau_get_datasource_metadata");
  assert.deepEqual(dispatched[0].input, { datasource_luid: "abc" });

  // Two round-trips; the second carried the assistant tool-call turn + a tool message.
  assert.equal(sent.length, 2);
  const secondMsgs = sent[1].messages;
  const assistantTurn = secondMsgs.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.ok(assistantTurn, "second request should replay the assistant tool_calls turn");
  assert.equal(assistantTurn.tool_plan, "I'll pull the datasource metadata.");
  const toolMsg = secondMsgs.find((m) => m.role === "tool");
  assert.ok(toolMsg, "second request should include a tool message");
  assert.equal(toolMsg.tool_call_id, "call_1");
  assert.deepEqual(JSON.parse(toolMsg.content), { ok: true, content: "fields: Grant Amount, Recipient" });

  // Request body is Cohere-shaped.
  assert.equal(sent[0].model, "command-a-plus-05-2026");
  assert.equal(sent[0].max_tokens, 1024);
  assert.equal(sent[0].temperature, 0.7);
  assert.equal(sent[0].tools[0].function.name, "tableau_get_datasource_metadata");

  // Final text is the model's last message; 'text' blocks only.
  assert.equal(result.text, "Final answer: 42 grants.");
  assert.equal(result.finishReason, "COMPLETE");
  assert.equal(result.truncated, false);
});

test("generateWithCohere passes a failed tool result through as a JSON tool message", async (t) => {
  configureCohere();
  const sent = [];
  let call = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            finish_reason: "TOOL_CALL",
            message: {
              role: "assistant",
              tool_calls: [{ id: "call_x", type: "function", function: { name: "tableau_query_datasource", arguments: "{}" } }],
            },
          });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ finish_reason: "COMPLETE", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; });

  await generateWithCohere({
    systemInstruction: "",
    contents: [{ role: "user", parts: [{ text: "q" }] }],
    maxOutputTokens: 256,
    temperature: 0,
    tools: [{ name: "tableau_query_datasource", description: "q", inputSchema: { type: "object", properties: {} } }],
    dispatchTool: async () => ({ ok: false, error: "boom" }),
  });

  const toolMsg = sent[1].messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "call_x");
  assert.deepEqual(JSON.parse(toolMsg.content), { ok: false, error: "boom" });
});

test("generateWithCohere without tools makes exactly one call (single-shot path)", async (t) => {
  configureCohere();
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ finish_reason: "COMPLETE", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; });

  const result = await generateWithCohere({
    systemInstruction: "",
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    maxOutputTokens: 128,
    temperature: 0.7,
  });
  assert.equal(calls, 1);
  assert.equal(result.text, "hi");
});

test("generateWithCohere omits temperature when not a finite number and drops 'thinking' blocks", async (t) => {
  configureCohere();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          finish_reason: "COMPLETE",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm let me think" },
              { type: "text", text: "answer" },
            ],
          },
        });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; });

  const result = await generateWithCohere({
    systemInstruction: "",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    maxOutputTokens: 64,
    temperature: undefined,
  });
  assert.equal(sent.length, 1);
  assert.equal("temperature" in sent[0], false, "temperature omitted when not finite");
  assert.equal(sent[0].max_tokens, 64);
  assert.equal(result.text, "answer"); // 'thinking' block excluded
});

test("generateWithCohere throws on an HTTP error (e.g. 401 bad key)", async (t) => {
  configureCohere();
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    async text() { return "invalid api token"; },
  });
  t.after(() => { global.fetch = realFetch; });

  await assert.rejects(
    () =>
      generateWithCohere({
        systemInstruction: "",
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        maxOutputTokens: 64,
        temperature: 0,
      }),
    /Cohere HTTP 401/,
  );
});

test("generateWithCohere safety valve nudges for a final answer at the round cap", async (t) => {
  configureCohere();
  process.env.COHERE_MAX_TOOL_ROUNDS = "2";

  const sent = [];
  let n = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    n += 1;
    // Always ask for a tool → burns rounds and trips the valve.
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          finish_reason: "TOOL_CALL",
          message: {
            role: "assistant",
            tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "tableau_query_datasource", arguments: "{}" } }],
          },
        });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; });

  const result = await generateWithCohere({
    systemInstruction: "sys",
    contents: [{ role: "user", parts: [{ text: "loop please" }] }],
    maxOutputTokens: 256,
    temperature: 0,
    tools: [{ name: "tableau_query_datasource", description: "q", inputSchema: { type: "object", properties: {} } }],
    dispatchTool: async () => ({ ok: false, error: "timeout" }),
  });

  // The last request carries a plain-text "final answer now" nudge as the last user turn.
  const last = sent[sent.length - 1];
  const lastUserTurn = [...last.messages].reverse().find((m) => m.role === "user");
  assert.match(lastUserTurn.content, /final answer now/i);
  assert.equal(result.finishReason, "TOOL_CALL"); // broke out at the cap
  assert.equal(sent.length, 3, "COHERE_MAX_TOOL_ROUNDS=2 → 2 tool rounds + 1 nudge (read at call time)");
});

test("generateWithCohere: a non-numeric COHERE_MAX_TOOL_ROUNDS falls back to 10, not 'no cap'", async (t) => {
  configureCohere();
  process.env.COHERE_MAX_TOOL_ROUNDS = "ten";
  let n = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    n += 1;
    if (n > 50) throw new Error("runaway tool loop — cap not enforced");
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          finish_reason: "TOOL_CALL",
          message: { role: "assistant", tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "t", arguments: "{}" } }] },
        });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; });

  await generateWithCohere({
    systemInstruction: "sys",
    contents: [{ role: "user", parts: [{ text: "loop" }] }],
    maxOutputTokens: 64,
    temperature: 0,
    tools: [{ name: "t", description: "q", inputSchema: { type: "object", properties: {} } }],
    dispatchTool: async () => ({ ok: false, error: "timeout" }),
  });
  assert.equal(n, 11, "10 tool rounds + 1 nudge");
});

test("generateWithCohere retries once for a plain-text answer when the final turn has no text", async (t) => {
  configureCohere();
  const sent = [];
  let n = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    n += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        // 1st turn: only a 'thinking' block (no visible text) → triggers the nudge.
        // 2nd turn: a real plain-text answer.
        return n === 1
          ? JSON.stringify({ finish_reason: "COMPLETE", message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning…" }] } })
          : JSON.stringify({ finish_reason: "COMPLETE", message: { role: "assistant", content: [{ type: "text", text: "recovered answer" }] } });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; });

  const result = await generateWithCohere({
    systemInstruction: "sys",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    maxOutputTokens: 128,
    temperature: 0,
  });

  assert.equal(sent.length, 2, "made a second call to nudge for a plain-text answer");
  const lastUserTurn = [...sent[1].messages].reverse().find((m) => m.role === "user");
  assert.match(lastUserTurn.content, /final answer now in plain text/i);
  assert.equal(result.text, "recovered answer");
});

// ----- Gateway auth modes (Azure OpenAI) -----
// The gateway path serves both the internal Claude gateway (bearer, default)
// and Azure OpenAI (azure-api-key or azure-ad via Managed Identity). These lock
// the header shape per mode so a future edit can't silently send the wrong one.

test("gatewayAuthMode defaults to bearer and recognizes the azure aliases", () => {
  assert.equal(gatewayAuthMode(), "bearer"); // unset
  for (const v of ["bearer", "BEARER", "anything-else", ""]) {
    process.env.LLM_GATEWAY_AUTH = v;
    assert.equal(gatewayAuthMode(), "bearer", `${JSON.stringify(v)} → bearer`);
  }
  for (const v of ["azure-api-key", "azure_api_key", "apikey", "api-key", "API-KEY"]) {
    process.env.LLM_GATEWAY_AUTH = v;
    assert.equal(gatewayAuthMode(), "azure-api-key", `${v} → azure-api-key`);
  }
  for (const v of ["azure-ad", "azure_ad", "aad", "entra", "Entra"]) {
    process.env.LLM_GATEWAY_AUTH = v;
    assert.equal(gatewayAuthMode(), "azure-ad", `${v} → azure-ad`);
  }
});

test("gatewayConfig: bearer + azure-api-key require an API key, azure-ad does not", () => {
  process.env.LLM_GATEWAY_URL = "https://res.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21";
  process.env.LLM_GATEWAY_MODEL = "gpt-4o";
  // No API key set.
  delete process.env.LLM_GATEWAY_API_KEY;

  process.env.LLM_GATEWAY_AUTH = "bearer";
  assert.equal(gatewayConfig(), null, "bearer needs a key");
  process.env.LLM_GATEWAY_AUTH = "azure-api-key";
  assert.equal(gatewayConfig(), null, "azure-api-key needs a key");

  // azure-ad is valid with NO static key — the Managed Identity supplies a token.
  process.env.LLM_GATEWAY_AUTH = "azure-ad";
  const cfg = gatewayConfig();
  assert.ok(cfg, "azure-ad is configured without an API key");
  assert.equal(cfg.authMode, "azure-ad");
  assert.equal(cfg.apiKey, "");

  // azure-ad still requires url + model.
  delete process.env.LLM_GATEWAY_MODEL;
  assert.equal(gatewayConfig(), null, "azure-ad still needs url + model");
});

test("gatewayAuthHeaders: bearer uses Authorization, azure-api-key uses api-key", async () => {
  const bearer = await gatewayAuthHeaders({ apiKey: "sk-live", authMode: "bearer" });
  assert.equal(bearer.Authorization, "Bearer sk-live");
  assert.equal(bearer["api-key"], undefined, "bearer must NOT send api-key");

  const azKey = await gatewayAuthHeaders({ apiKey: "azure-secret", authMode: "azure-api-key" });
  assert.equal(azKey["api-key"], "azure-secret");
  assert.equal(azKey.Authorization, undefined, "azure-api-key must NOT send Authorization (Azure rejects a Bearer key)");
});

test("gatewayAuthHeaders: azure-ad fetches an Entra token and sends it as a Bearer", async () => {
  _resetAzureTokenCache();
  let calls = 0;
  const headers = await gatewayAuthHeaders(
    { apiKey: "", authMode: "azure-ad" },
    { __getToken: async (scope) => { calls += 1; assert.match(scope, /cognitiveservices\.azure\.com/); return { token: "entra-tok-1", expiresOnTimestamp: Date.now() + 3600000 }; } },
  );
  assert.equal(headers.Authorization, "Bearer entra-tok-1");
  assert.equal(headers["api-key"], undefined);
  assert.equal(calls, 1);
});

test("getAzureAccessToken caches within expiry and refreshes past it", async () => {
  _resetAzureTokenCache();
  let issued = 0;
  const factory = async () => {
    issued += 1;
    // Each token is valid ~10 min from now; the 2-min skew keeps it cached.
    return { token: `tok-${issued}`, expiresOnTimestamp: Date.now() + 600000 };
  };
  const a = await getAzureAccessToken({ __getToken: factory });
  const b = await getAzureAccessToken({ __getToken: factory });
  assert.equal(a, "tok-1");
  assert.equal(b, "tok-1", "second call within expiry is served from cache");
  assert.equal(issued, 1, "no second acquisition while cached");

  // A token that's already past the skew window forces a refresh.
  _resetAzureTokenCache();
  let n = 0;
  const expiringFactory = async () => { n += 1; return { token: `x-${n}`, expiresOnTimestamp: Date.now() + 1000 }; };
  const c = await getAzureAccessToken({ __getToken: expiringFactory });
  const d = await getAzureAccessToken({ __getToken: expiringFactory });
  assert.equal(c, "x-1");
  assert.equal(d, "x-2", "expired-past-skew token is refreshed");
});

test("getAzureAccessToken throws a clear error when the credential returns no token", async () => {
  _resetAzureTokenCache();
  await assert.rejects(
    () => getAzureAccessToken({ __getToken: async () => null }),
    /no token/i,
  );
});

test("generateWithGateway sends the api-key header in azure-api-key mode (fetch stubbed)", async (t) => {
  process.env.LLM_GATEWAY_URL = "https://res.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21";
  process.env.LLM_GATEWAY_MODEL = "gpt-4o";
  process.env.LLM_GATEWAY_API_KEY = "azure-secret";
  process.env.LLM_GATEWAY_AUTH = "azure-api-key";

  const realFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: "hello from azure" }, finish_reason: "stop" }] });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; });

  const out = await generateWithGateway({
    systemInstruction: "sys",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    maxOutputTokens: 128,
    temperature: 0.2,
  });

  assert.equal(out.text, "hello from azure");
  assert.equal(captured.init.headers["api-key"], "azure-secret");
  assert.equal(captured.init.headers.Authorization, undefined);
  // Body is still OpenAI-shaped.
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "gpt-4o");
  assert.equal(body.max_tokens, 128);
});

test("generateWithGateway uses an Entra Bearer token in azure-ad mode (fetch + token stubbed)", async (t) => {
  _resetAzureTokenCache();
  process.env.LLM_GATEWAY_URL = "https://res.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21";
  process.env.LLM_GATEWAY_MODEL = "gpt-4o";
  delete process.env.LLM_GATEWAY_API_KEY; // no static key on the MI path
  process.env.LLM_GATEWAY_AUTH = "azure-ad";

  const realFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; _resetAzureTokenCache(); });

  const out = await generateWithGateway({
    systemInstruction: "",
    contents: [{ role: "user", parts: [{ text: "q" }] }],
    maxOutputTokens: 64,
    temperature: 0,
    __getToken: async () => ({ token: "mi-token-abc", expiresOnTimestamp: Date.now() + 3600000 }),
  });

  assert.equal(out.text, "hi");
  assert.equal(captured.init.headers.Authorization, "Bearer mi-token-abc");
  assert.equal(captured.init.headers["api-key"], undefined);
});

test("generateWithGateway default (bearer) header is unchanged", async (t) => {
  process.env.LLM_GATEWAY_URL = "https://gw/v1/chat/completions";
  process.env.LLM_GATEWAY_MODEL = "claude-sonnet-4-6";
  process.env.LLM_GATEWAY_API_KEY = "sk-test";
  // LLM_GATEWAY_AUTH intentionally unset → bearer.

  const realFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      },
    };
  };
  t.after(() => { global.fetch = realFetch; });

  await generateWithGateway({
    systemInstruction: "sys",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    maxOutputTokens: 32,
    temperature: 0.5,
  });
  assert.equal(captured.init.headers.Authorization, "Bearer sk-test");
  assert.equal(captured.init.headers["api-key"], undefined);
  assert.equal(captured.url, "https://gw/v1/chat/completions");
});
