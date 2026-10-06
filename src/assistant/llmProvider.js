/**
 * LLM provider abstraction.
 *
 * Three backends behind one `generateReply()` call:
 *  - "vertex"  (default): Vertex AI / Gemini via @google/genai.
 *  - "gateway": OpenAI-compatible /v1/chat/completions endpoint. Serves the
 *               internal LLM gateway (Claude) AND Azure OpenAI / AI Foundry —
 *               the auth scheme is selected by LLM_GATEWAY_AUTH (bearer default,
 *               azure-api-key, or azure-ad via Managed Identity).
 *  - "bedrock": AWS Bedrock Converse API, serving Claude natively.
 *  - "cohere":  Cohere v2 Chat API, serving Command models (e.g. Command A Plus)
 *               natively, with an agentic tool-use loop for the Tableau tools.
 *
 * Select with AI_PROVIDER = "vertex" | "gateway" | "bedrock" | "cohere". A
 * gateway, bedrock, or cohere config that is present but incomplete falls back
 * to vertex so a misconfiguration never silently breaks replies.
 *
 * Normalized request shape (provider-agnostic):
 *   {
 *     systemInstruction: string,
 *     contents: Array<{ role: "user"|"model", parts: [{ text }] }>,  // Gemini-native
 *     maxOutputTokens: number,
 *     temperature: number,
 *     googleSearchActive: boolean,   // Gemini-only; ignored by gateway
 *   }
 *
 * Normalized response:
 *   { text: string, finishReason: string|null, truncated: boolean, safety: boolean }
 */

let _genAiClient = null;

function selectedProvider() {
  const p = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (p === "gateway" && gatewayConfig()) return "gateway";
  if (p === "bedrock" && bedrockConfig()) return "bedrock";
  if (p === "cohere" && cohereConfig()) return "cohere";
  return "vertex";
}

/**
 * Output-token budget for a caller that didn't pin one. LLM_MAX_OUTPUT_TOKENS (or
 * the legacy GEMINI_MAX_OUTPUT_TOKENS) always wins. Otherwise 4096 — except on
 * Cohere, where Command A Plus's thinking content counts against max_tokens, so a
 * 4096 budget can end a multi-tool turn with only a thinking block (empty reply).
 * 8192 is the budget verified to leave room for the answer.
 */
function defaultMaxOutputTokens() {
  const fromEnv =
    Number(process.env.LLM_MAX_OUTPUT_TOKENS) || Number(process.env.GEMINI_MAX_OUTPUT_TOKENS);
  if (fromEnv) return fromEnv;
  return selectedProvider() === "cohere" ? 8192 : 4096;
}

/**
 * Auth scheme for the OpenAI-compatible gateway, from LLM_GATEWAY_AUTH:
 *   - "bearer" (default): Authorization: Bearer <LLM_GATEWAY_API_KEY>. Today's
 *     behavior — the internal Claude gateway. Unchanged when the var is unset.
 *   - "azure-api-key": api-key: <LLM_GATEWAY_API_KEY>. Azure OpenAI addressed
 *     with a resource key.
 *   - "azure-ad": Authorization: Bearer <Entra token>. Azure OpenAI via a
 *     Managed Identity (DefaultAzureCredential) — NO static key to store or
 *     rotate. The token is fetched and cached at call time.
 */
function gatewayAuthMode() {
  const m = String(process.env.LLM_GATEWAY_AUTH || "").trim().toLowerCase();
  if (m === "azure-api-key" || m === "azure_api_key" || m === "apikey" || m === "api-key") return "azure-api-key";
  if (m === "azure-ad" || m === "azure_ad" || m === "aad" || m === "entra") return "azure-ad";
  return "bearer";
}

function gatewayConfig() {
  const url = String(process.env.LLM_GATEWAY_URL || "").trim();
  const apiKey = String(process.env.LLM_GATEWAY_API_KEY || "").trim();
  const model = String(process.env.LLM_GATEWAY_MODEL || "").trim();
  const authMode = gatewayAuthMode();
  // url + model are always required. A static API key is required for the
  // key-based modes (bearer, azure-api-key) but NOT for azure-ad, where a
  // Managed Identity supplies a short-lived bearer token at call time.
  if (!url || !model) return null;
  if (authMode !== "azure-ad" && !apiKey) return null;
  return { url, apiKey, model, authMode };
}

// ----- Azure Entra token (Managed Identity) for the azure-ad gateway mode -----

// Azure OpenAI's OAuth resource scope. The MI must hold the
// "Cognitive Services OpenAI User" role on the target Azure OpenAI resource.
const AZURE_OPENAI_SCOPE = "https://cognitiveservices.azure.com/.default";

let _azureCredential = null;
let _azureTokenCache = null; // { token: string, expiresOnMs: number }

function getAzureCredential() {
  if (_azureCredential) return _azureCredential;
  let DefaultAzureCredential;
  try {
    ({ DefaultAzureCredential } = require("@azure/identity"));
  } catch (_) {
    throw new Error(
      "LLM_GATEWAY_AUTH=azure-ad requires the '@azure/identity' package. " +
        "Add it to the image (npm i @azure/identity) or use LLM_GATEWAY_AUTH=azure-api-key.",
    );
  }
  _azureCredential = new DefaultAzureCredential();
  return _azureCredential;
}

/**
 * Fetch (and cache) an Entra access token for Azure OpenAI, refreshing ~2 min
 * before expiry so a long-lived process never sends an expired token.
 * @param {object} [opts]
 * @param {(scope:string)=>Promise<{token:string, expiresOnTimestamp?:number}>} [opts.__getToken]
 *   Test seam: inject a token factory so tests exercise this path without
 *   '@azure/identity' or a real Managed Identity (mirrors the bedrock __client seam).
 */
async function getAzureAccessToken(opts = {}) {
  const now = Date.now();
  const SKEW_MS = 120000; // refresh 2 minutes early
  if (_azureTokenCache && _azureTokenCache.expiresOnMs - SKEW_MS > now) {
    return _azureTokenCache.token;
  }
  const getToken = opts.__getToken || ((scope) => getAzureCredential().getToken(scope));
  const res = await getToken(AZURE_OPENAI_SCOPE);
  if (!res || !res.token) {
    throw new Error("Azure AD token acquisition returned no token (check Managed Identity / DefaultAzureCredential).");
  }
  _azureTokenCache = {
    token: res.token,
    // getToken returns expiresOnTimestamp in ms since epoch; default to +1h.
    expiresOnMs: typeof res.expiresOnTimestamp === "number" ? res.expiresOnTimestamp : now + 3600000,
  };
  return _azureTokenCache.token;
}

/** Test/ops helper: drop the cached Azure token + credential. */
function _resetAzureTokenCache() {
  _azureTokenCache = null;
  _azureCredential = null;
}

/**
 * Build the request headers for the gateway call, per the configured auth mode.
 * Kept separate so the header shape is unit-testable without a live fetch.
 */
async function gatewayAuthHeaders(cfg, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.authMode === "azure-api-key") {
    // Azure OpenAI with a resource key: the key rides in `api-key`, NOT in
    // Authorization (sending Bearer here would be rejected).
    headers["api-key"] = cfg.apiKey;
  } else if (cfg.authMode === "azure-ad") {
    const token = await getAzureAccessToken(opts);
    headers.Authorization = `Bearer ${token}`;
  } else {
    // Default bearer scheme — unchanged from the original gateway behavior.
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }
  return headers;
}

/**
 * AWS Bedrock config. Requires a model id and a region; AWS credentials are
 * resolved by the SDK's default provider chain (env vars, shared config, or an
 * assumed role), so we don't read the secret/session token directly here.
 * Returns null if the required pieces are missing so selectedProvider() falls
 * back to vertex rather than silently breaking replies.
 *
 * Credentials may take any of these forms (the SDK's default provider chain
 * resolves them at call time; here we just detect that *a* source is present):
 *  - A long-term Bedrock API key in AWS_BEARER_TOKEN_BEDROCK. The SDK detects
 *    this env var, switches its auth scheme to httpBearerAuth automatically
 *    (see @aws-sdk/core httpAuthSchemes), and never needs a session token — so
 *    it doesn't expire the way STS (ASIA…) creds do.
 *  - Classic SigV4 access-key creds in AWS_ACCESS_KEY_ID (+ secret / session).
 *  - A container/instance role: App Runner and ECS inject the container
 *    credentials endpoint via AWS_CONTAINER_CREDENTIALS_RELATIVE_URI /
 *    AWS_CONTAINER_CREDENTIALS_FULL_URI; the SDK's remote provider reads it.
 *    This is the RECOMMENDED path for the AWS deploy (see deploy/aws — the
 *    instance role grants bedrock:InvokeModel, so no static key is set).
 *  - EKS/IRSA web identity: AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN.
 * Without this broader detection, a role-based deploy (no key env vars) would
 * wrongly look "unconfigured" and silently fall back to vertex.
 */
function bedrockConfig() {
  const model = String(process.env.BEDROCK_MODEL_ID || "").trim();
  const region = String(
    process.env.BEDROCK_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "",
  ).trim();
  const present = (k) => Boolean(String(process.env[k] || "").trim());
  const hasCreds =
    present("AWS_BEARER_TOKEN_BEDROCK") || // long-term Bedrock API key
    present("AWS_ACCESS_KEY_ID") || // static SigV4 creds
    present("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") || // ECS/App Runner role
    present("AWS_CONTAINER_CREDENTIALS_FULL_URI") || // App Runner role
    (present("AWS_WEB_IDENTITY_TOKEN_FILE") && present("AWS_ROLE_ARN")); // EKS IRSA
  if (!model || !region || !hasCreds) return null;
  return { model, region };
}

/**
 * Cohere config. Requires an API key and a model id, both from env. The v2 Chat
 * API is a plain HTTPS + bearer endpoint (no SDK), so there are no extra
 * credential forms to detect. Returns null when either piece is missing so
 * selectedProvider() falls back to vertex rather than silently breaking replies.
 */
function cohereConfig() {
  const apiKey = String(process.env.COHERE_API_KEY || "").trim();
  const model = String(process.env.COHERE_MODEL_ID || "").trim();
  if (!apiKey || !model) return null;
  // Allow an override for Cohere-compatible / private endpoints; default to the
  // public v2 Chat API. A trailing slash is tolerated.
  const baseUrl = String(process.env.COHERE_BASE_URL || "https://api.cohere.com")
    .trim()
    .replace(/\/+$/, "");
  return { apiKey, model, baseUrl };
}

// ----- Vertex / Gemini -----

function getGeminiClient() {
  if (_genAiClient) return _genAiClient;
  const { GoogleGenAI } = require("@google/genai");
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  if (!project) throw new Error("Missing GOOGLE_CLOUD_PROJECT. Set it in .env for Vertex/Gemini.");
  // Bound each Gemini call so a stalled upstream can't hang a Slack turn forever.
  // Generous default (won't fire on healthy calls); override with LLM_REQUEST_TIMEOUT_MS.
  const timeout = Number(process.env.LLM_REQUEST_TIMEOUT_MS) || 60000;
  _genAiClient = new GoogleGenAI({ vertexai: true, project, location, httpOptions: { timeout } });
  return _genAiClient;
}

function textFromGeminiCandidate(candidate) {
  const parts = candidate?.content?.parts || [];
  return parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join("")
    .trim();
}

async function generateWithGemini({ modelId, systemInstruction, contents, maxOutputTokens, temperature, googleSearchActive }) {
  const ai = getGeminiClient();
  const tools = googleSearchActive ? [{ googleSearch: {} }] : undefined;
  const config = {
    systemInstruction,
    maxOutputTokens,
    temperature,
    ...(tools ? { tools } : {}),
  };
  const response = await ai.models.generateContent({ model: modelId, contents, config });
  const candidate = response?.candidates?.[0];
  if (!candidate) return { text: "", finishReason: null, truncated: false, safety: false };
  const finishReason = candidate.finishReason || null;
  return {
    text: textFromGeminiCandidate(candidate),
    finishReason,
    truncated: finishReason === "MAX_TOKENS",
    safety: finishReason === "SAFETY",
  };
}

// ----- Gateway (OpenAI-compatible, serving Claude) -----

/** Convert Gemini-native contents to OpenAI chat messages. */
function contentsToOpenAiMessages(systemInstruction, contents) {
  const messages = [];
  if (systemInstruction && systemInstruction.trim()) {
    messages.push({ role: "system", content: systemInstruction.trim() });
  }
  for (const c of contents || []) {
    const text = (c.parts || [])
      .filter((p) => p && p.text)
      .map((p) => p.text)
      .join("");
    if (!text.trim()) continue;
    messages.push({ role: c.role === "model" ? "assistant" : "user", content: text });
  }
  return messages;
}

// ----- AWS Bedrock (Converse API, serving Claude natively) -----

let _bedrockClient = null;

function getBedrockClient(region) {
  if (_bedrockClient) return _bedrockClient;
  const { BedrockRuntimeClient } = require("@aws-sdk/client-bedrock-runtime");
  // Credentials resolve from the environment automatically: if
  // AWS_BEARER_TOKEN_BEDROCK is set the SDK uses httpBearerAuth (long-term
  // Bedrock API key, no expiry churn); otherwise it falls back to SigV4 with
  // AWS_ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _SESSION_TOKEN. No explicit client
  // config is needed for either path.
  _bedrockClient = new BedrockRuntimeClient({ region });
  return _bedrockClient;
}

/**
 * Convert Gemini-native contents into Bedrock Converse messages.
 * Converse wants role "user"|"assistant" and content as [{ text }] blocks,
 * with the system prompt passed separately. It also rejects empty messages and
 * requires messages to alternate, so we merge consecutive same-role turns.
 */
function contentsToBedrockMessages(contents) {
  const messages = [];
  for (const c of contents || []) {
    const text = (c.parts || [])
      .filter((p) => p && p.text)
      .map((p) => p.text)
      .join("");
    if (!text.trim()) continue;
    const role = c.role === "model" ? "assistant" : "user";
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push({ text });
    } else {
      messages.push({ role, content: [{ text }] });
    }
  }
  return messages;
}

/**
 * Build a Bedrock Converse toolConfig from provider-neutral tool specs.
 * @param {Array<{name:string, description?:string, inputSchema:object}>} tools
 */
function toolSpecsToConverseToolConfig(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return {
    tools: tools.map((t) => ({
      toolSpec: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        inputSchema: { json: t.inputSchema || { type: "object", properties: {} } },
      },
    })),
  };
}

const BEDROCK_MAX_TOOL_ROUNDS = Number(process.env.BEDROCK_MAX_TOOL_ROUNDS || 10);

/**
 * @param {object} req
 * @param {Array<{name:string, description?:string, inputSchema:object}>} [req.tools]
 * @param {(name:string, input:object) => Promise<object>} [req.dispatchTool]
 *   Called for each tool the model requests; returns a plain JSON-serializable
 *   result object. Only used when req.tools is non-empty.
 */
async function generateWithBedrock({
  systemInstruction,
  contents,
  maxOutputTokens,
  temperature,
  tools,
  dispatchTool,
  bedrockModelId, // optional per-agent model pin (defineAgent); overrides cfg.model
  __client, // test seam: inject a fake { send } client
}) {
  const cfg = bedrockConfig();
  if (!cfg) throw new Error("Bedrock is not configured (BEDROCK_MODEL_ID / region / AWS credentials).");
  // A per-call model override lets a specialized agent pin its own model (e.g. a
  // fixed Sonnet for reproducible eval scores) independent of the app-wide
  // BEDROCK_MODEL_ID. Falls back to the configured model when unset, so the
  // baseline path (which never sets this) is unchanged.
  const modelId = String(bedrockModelId || "").trim() || cfg.model;

  const { ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
  const client = __client || getBedrockClient(cfg.region);
  const messages = contentsToBedrockMessages(contents);
  // Converse requires at least one message and a leading user turn.
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ text: "(no message)" }] });
  }

  const toolConfig = toolSpecsToConverseToolConfig(tools);
  const canDispatch = toolConfig && typeof dispatchTool === "function";

  // Some newer Claude models on Bedrock (e.g. Sonnet 5) reject the `temperature`
  // inference parameter outright ("`temperature` is deprecated for this model").
  // Include it only when it's a finite number, and fall back to sending without
  // it if the model rejects it — so we don't have to hardcode per-model support.
  const includeTemperature = Number.isFinite(temperature);
  const baseParams = {
    modelId,
    ...(systemInstruction && systemInstruction.trim()
      ? { system: [{ text: systemInstruction.trim() }] }
      : {}),
    inferenceConfig: {
      maxTokens: maxOutputTokens,
      ...(includeTemperature ? { temperature } : {}),
    },
    ...(toolConfig ? { toolConfig } : {}),
  };

  // Send a Converse request; if the model complains that `temperature` is
  // deprecated/unsupported, strip it and retry once. The retry result is cached
  // in a flag so subsequent loop iterations skip temperature entirely.
  // Per-call deadline so a stalled Bedrock response can't hang a Slack turn.
  // Generous default (won't fire on healthy calls); override with LLM_REQUEST_TIMEOUT_MS.
  const converseTimeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS) || 60000;
  let temperatureUnsupported = false;
  async function sendConverse(params) {
    const stripTemp = (p) => {
      const ic = { ...(p.inferenceConfig || {}) };
      delete ic.temperature;
      return { ...p, inferenceConfig: ic };
    };
    if (temperatureUnsupported) params = stripTemp(params);
    const opts = { abortSignal: AbortSignal.timeout(converseTimeoutMs) };
    try {
      return await client.send(new ConverseCommand(params), opts);
    } catch (err) {
      const msg = (err && (err.message || String(err))) || "";
      if (!temperatureUnsupported && /temperature/i.test(msg) && /deprecat|unsupport|not support|invalid|remove/i.test(msg)) {
        temperatureUnsupported = true;
        return await client.send(new ConverseCommand(stripTemp(params)), { abortSignal: AbortSignal.timeout(converseTimeoutMs) });
      }
      throw err;
    }
  }

  // Agentic loop: keep servicing tool_use stops until the model produces a final
  // answer (or we hit the round cap). Without tools this runs exactly once, so
  // the non-tool path is unchanged.
  let out;
  let rounds = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    out = await sendConverse({ ...baseParams, messages });
    const stopReason = out.stopReason || null;
    const assistantMsg = out.output?.message;

    if (stopReason !== "tool_use" || !canDispatch || !assistantMsg) break;

    const toolUses = (assistantMsg.content || []).filter((b) => b && b.toolUse);
    if (toolUses.length === 0) break;

    // Record the assistant's tool-use turn, then answer every requested tool.
    messages.push({ role: assistantMsg.role || "assistant", content: assistantMsg.content });

    const toolResults = [];
    for (const b of toolUses) {
      const { toolUseId, name, input } = b.toolUse;
      let result;
      try {
        result = await dispatchTool(name, input || {});
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) };
      }
      const ok = !result || result.ok !== false;
      toolResults.push({
        toolResult: {
          toolUseId,
          content: [{ json: result == null ? { ok: false } : result }],
          status: ok ? "success" : "error",
        },
      });
    }
    messages.push({ role: "user", content: toolResults });

    rounds += 1;
    if (rounds >= BEDROCK_MAX_TOOL_ROUNDS) {
      // Safety valve: nudge for a final answer so we don't loop forever if the
      // model keeps requesting tools (e.g. a tool that repeatedly errors/times
      // out). Bedrock REQUIRES toolConfig to stay defined whenever the message
      // history contains toolUse/toolResult blocks — which it now does — so we
      // KEEP toolConfig and instruct the model to stop, rather than removing it.
      // (Sending toolConfig:undefined here throws "The toolConfig field must be
      // defined when using toolUse and toolResult content blocks.")
      messages.push({
        role: "user",
        content: [{ text: "Provide your final answer now in plain text. Do not call any more tools." }],
      });
      out = await sendConverse({ ...baseParams, messages });
      break;
    }
  }

  const text = (out.output?.message?.content || [])
    .filter((b) => b && b.text)
    .map((b) => b.text)
    .join("")
    .trim();
  const stopReason = out.stopReason || null;
  return {
    text,
    finishReason: stopReason,
    // Bedrock reports "max_tokens" when the output cap is hit.
    truncated: stopReason === "max_tokens",
    safety: stopReason === "content_filtered" || stopReason === "guardrail_intervened",
  };
}

async function generateWithGateway({ systemInstruction, contents, maxOutputTokens, temperature, __getToken }) {
  const cfg = gatewayConfig();
  if (!cfg) throw new Error("LLM gateway is not configured (LLM_GATEWAY_URL / _MODEL and, unless azure-ad, _API_KEY).");

  const messages = contentsToOpenAiMessages(systemInstruction, contents);
  const timeoutMs = Number(process.env.LLM_GATEWAY_TIMEOUT_MS) || 60000;

  // Header shape varies by LLM_GATEWAY_AUTH: bearer (default), azure-api-key, or
  // azure-ad (Managed Identity token). __getToken is a test seam for azure-ad.
  const headers = await gatewayAuthHeaders(cfg, { __getToken });

  const res = await fetch(cfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: maxOutputTokens,
      temperature,
    }),
    // Don't follow a 3xx: the bearer API key would be replayed to the redirect
    // target. The gateway must answer directly (mirrors the MCP-fetch hardening).
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`LLM gateway HTTP ${res.status}: ${raw.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (_) {
    throw new Error(`LLM gateway returned non-JSON: ${raw.slice(0, 200)}`);
  }
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const text = (typeof content === "string" ? content : "").trim();
  const finishReason = choice?.finish_reason || null;
  return {
    text,
    finishReason,
    // OpenAI-compatible servers report "length" when the token cap is hit.
    truncated: finishReason === "length",
    safety: finishReason === "content_filter",
  };
}

// ----- Cohere (v2 Chat API, serving Command models natively) -----

const COHERE_MAX_TOOL_ROUNDS = Number(process.env.COHERE_MAX_TOOL_ROUNDS || 10);

/**
 * Convert provider-neutral tool specs to Cohere v2 tools. The inputSchema is
 * already JSON Schema — exactly what Cohere's `function.parameters` wants — so
 * this is a 1:1 wrap.
 * @param {Array<{name:string, description?:string, inputSchema:object}>} tools
 */
function toolSpecsToCohereTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
}

/**
 * Generate a reply with Cohere's v2 Chat API, running the same agentic tool-use
 * loop as the Bedrock path: keep servicing `finish_reason: "TOOL_CALL"` stops
 * (dispatch each requested tool, feed a `tool` message back) until the model
 * produces a final text answer or we hit the round cap. Without tools this runs
 * exactly once, so the non-tool path is a single call.
 *
 * Cohere v2 messages are OpenAI-shaped (system/user/assistant/tool with string
 * content), so we reuse contentsToOpenAiMessages for the base history and only
 * the tool-call / tool-result turns are Cohere-specific.
 *
 * @param {object} req
 * @param {Array<{name:string, description?:string, inputSchema:object}>} [req.tools]
 * @param {(name:string, input:object) => Promise<object>} [req.dispatchTool]
 */
async function generateWithCohere({ systemInstruction, contents, maxOutputTokens, temperature, tools, dispatchTool }) {
  const cfg = cohereConfig();
  if (!cfg) throw new Error("Cohere is not configured (COHERE_API_KEY / COHERE_MODEL_ID).");

  const messages = contentsToOpenAiMessages(systemInstruction, contents);
  const cohereTools = toolSpecsToCohereTools(tools);
  const canDispatch = cohereTools && typeof dispatchTool === "function";
  const timeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS) || 60000;

  async function send() {
    const res = await fetch(`${cfg.baseUrl}/v2/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        ...(cohereTools ? { tools: cohereTools } : {}),
        max_tokens: maxOutputTokens,
        ...(Number.isFinite(temperature) ? { temperature } : {}),
      }),
      // Don't follow a 3xx: the bearer API key would be replayed to the redirect
      // target (mirrors the gateway / MCP-fetch hardening).
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Cohere HTTP ${res.status}: ${raw.slice(0, 300)}`);
    try {
      return JSON.parse(raw);
    } catch (_) {
      throw new Error(`Cohere returned non-JSON: ${raw.slice(0, 200)}`);
    }
  }

  // Agentic loop: without tools it runs exactly once.
  let out;
  let rounds = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    out = await send();
    const msg = out.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (out.finish_reason !== "TOOL_CALL" || !canDispatch || toolCalls.length === 0) break;

    // Record the assistant's tool-call turn (keep tool_plan so the reasoning
    // chain is preserved for the model), then answer every requested tool.
    messages.push({
      role: "assistant",
      ...(msg.tool_plan ? { tool_plan: msg.tool_plan } : {}),
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      let input = {};
      try {
        input = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (_) {
        input = {}; // malformed args → let the tool report the miss
      }
      let result;
      try {
        result = await dispatchTool(tc.function?.name, input);
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) };
      }
      // Cohere requires a `tool` message per tool_call_id. A JSON-string body is
      // accepted (the alternative is an array of content blocks).
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result == null ? { ok: false } : result),
      });
    }

    rounds += 1;
    if (rounds >= COHERE_MAX_TOOL_ROUNDS) {
      // Safety valve: nudge for a final answer so a tool that keeps erroring
      // can't loop forever (mirrors the Bedrock round cap).
      messages.push({ role: "user", content: "Provide your final answer now in plain text. Do not call any more tools." });
      out = await send();
      break;
    }
  }

  // Pull the visible answer out of a response, dropping Cohere 'thinking' blocks.
  const extractText = (o) =>
    (o.message?.content || [])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
  const contentTypesOf = (o) => (o.message?.content || []).map((b) => b && b.type).filter(Boolean);

  let finishReason = out.finish_reason || null;
  // ERROR/TIMEOUT are model-side failures — surface them so the caller's
  // catch-all reports an error rather than returning a silent empty reply.
  if (finishReason === "ERROR" || finishReason === "TIMEOUT") {
    throw new Error(`Cohere finish_reason=${finishReason}`);
  }

  let text = extractText(out);

  // Command A Plus sometimes ends a turn with only a 'thinking' block and no
  // visible 'text' (it stopped to reason, or truncated mid-thought). That would
  // otherwise reach the user as the empty "I didn't get a clear response"
  // fallback with no trace. Log the response shape, and — unless we already
  // asked at the round cap — make one explicit plain-text request before giving
  // up. This is the same nudge the round-cap valve uses.
  if (!text) {
    const nudge = "Provide your final answer now in plain text. Do not call any more tools.";
    const lastMsg = messages[messages.length - 1];
    const alreadyNudged = lastMsg && lastMsg.role === "user" && String(lastMsg.content || "").includes(nudge);
    console.warn(
      `[cohere] empty answer text (finish_reason=${finishReason}, rounds=${rounds}, content=[${contentTypesOf(out).join(",")}])` +
        (alreadyNudged ? " — already nudged, giving up." : " — retrying once for a plain-text answer."),
    );
    if (!alreadyNudged) {
      messages.push({ role: "user", content: nudge });
      out = await send();
      finishReason = out.finish_reason || null;
      if (finishReason === "ERROR" || finishReason === "TIMEOUT") {
        throw new Error(`Cohere finish_reason=${finishReason}`);
      }
      text = extractText(out);
      if (!text) {
        console.warn(`[cohere] still empty after nudge (finish_reason=${finishReason}, content=[${contentTypesOf(out).join(",")}]).`);
      }
    }
  }

  return {
    text,
    finishReason,
    truncated: finishReason === "MAX_TOKENS",
    safety: false, // Cohere has no content-filter finish_reason
  };
}

/**
 * Generate a reply with whichever backend is configured.
 * @param {object} req - normalized request (see file header)
 * @param {{ modelId?: string }} [opts] - modelId used by the vertex backend
 * @returns {Promise<{ text: string, finishReason: string|null, truncated: boolean, safety: boolean, provider: string }>}
 */
async function generateReply(req, opts = {}) {
  const provider = selectedProvider();
  if (provider === "gateway") {
    const out = await generateWithGateway(req);
    return { ...out, provider };
  }
  if (provider === "bedrock") {
    const out = await generateWithBedrock(req);
    return { ...out, provider };
  }
  if (provider === "cohere") {
    const out = await generateWithCohere(req);
    return { ...out, provider };
  }
  const out = await generateWithGemini({ ...req, modelId: opts.modelId });
  return { ...out, provider };
}

module.exports = {
  generateReply,
  selectedProvider,
  defaultMaxOutputTokens,
  gatewayConfig,
  gatewayAuthMode,
  bedrockConfig,
  cohereConfig,
  // exported for tests
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
};
