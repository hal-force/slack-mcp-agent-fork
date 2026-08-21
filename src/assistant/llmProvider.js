/**
 * LLM provider abstraction.
 *
 * Three backends behind one `generateReply()` call:
 *  - "vertex"  (default): Vertex AI / Gemini via @google/genai.
 *  - "gateway": OpenAI-compatible /v1/chat/completions endpoint (used by the
 *               internal LLM gateway that serves Claude models).
 *  - "bedrock": AWS Bedrock Converse API, serving Claude natively.
 *
 * Select with AI_PROVIDER = "vertex" | "gateway" | "bedrock". A gateway or
 * bedrock config that is present but incomplete falls back to vertex so a
 * misconfiguration never silently breaks replies.
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
  return "vertex";
}

function gatewayConfig() {
  const url = String(process.env.LLM_GATEWAY_URL || "").trim();
  const apiKey = String(process.env.LLM_GATEWAY_API_KEY || "").trim();
  const model = String(process.env.LLM_GATEWAY_MODEL || "").trim();
  if (!url || !apiKey || !model) return null;
  return { url, apiKey, model };
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

// ----- Vertex / Gemini -----

function getGeminiClient() {
  if (_genAiClient) return _genAiClient;
  const { GoogleGenAI } = require("@google/genai");
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  if (!project) throw new Error("Missing GOOGLE_CLOUD_PROJECT. Set it in .env for Vertex/Gemini.");
  _genAiClient = new GoogleGenAI({ vertexai: true, project, location });
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
  let temperatureUnsupported = false;
  async function sendConverse(params) {
    const stripTemp = (p) => {
      const ic = { ...(p.inferenceConfig || {}) };
      delete ic.temperature;
      return { ...p, inferenceConfig: ic };
    };
    if (temperatureUnsupported) params = stripTemp(params);
    try {
      return await client.send(new ConverseCommand(params));
    } catch (err) {
      const msg = (err && (err.message || String(err))) || "";
      if (!temperatureUnsupported && /temperature/i.test(msg) && /deprecat|unsupport|not support|invalid|remove/i.test(msg)) {
        temperatureUnsupported = true;
        return await client.send(new ConverseCommand(stripTemp(params)));
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

async function generateWithGateway({ systemInstruction, contents, maxOutputTokens, temperature }) {
  const cfg = gatewayConfig();
  if (!cfg) throw new Error("LLM gateway is not configured (LLM_GATEWAY_URL / _API_KEY / _MODEL).");

  const messages = contentsToOpenAiMessages(systemInstruction, contents);
  const timeoutMs = Number(process.env.LLM_GATEWAY_TIMEOUT_MS) || 60000;

  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: maxOutputTokens,
      temperature,
    }),
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
  const out = await generateWithGemini({ ...req, modelId: opts.modelId });
  return { ...out, provider };
}

module.exports = {
  generateReply,
  selectedProvider,
  gatewayConfig,
  bedrockConfig,
  // exported for tests
  contentsToOpenAiMessages,
  contentsToBedrockMessages,
  toolSpecsToConverseToolConfig,
  generateWithBedrock,
};
