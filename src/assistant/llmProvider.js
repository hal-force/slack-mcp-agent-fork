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
 */
function bedrockConfig() {
  const model = String(process.env.BEDROCK_MODEL_ID || "").trim();
  const region = String(
    process.env.BEDROCK_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "",
  ).trim();
  const hasCreds = Boolean(String(process.env.AWS_ACCESS_KEY_ID || "").trim());
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
  // Credentials come from the SDK default provider chain (AWS_ACCESS_KEY_ID /
  // _SECRET_ACCESS_KEY / _SESSION_TOKEN env vars on Heroku).
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

async function generateWithBedrock({ systemInstruction, contents, maxOutputTokens, temperature }) {
  const cfg = bedrockConfig();
  if (!cfg) throw new Error("Bedrock is not configured (BEDROCK_MODEL_ID / region / AWS credentials).");

  const { ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
  const client = getBedrockClient(cfg.region);
  const messages = contentsToBedrockMessages(contents);
  // Converse requires at least one message and a leading user turn.
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ text: "(no message)" }] });
  }

  const out = await client.send(
    new ConverseCommand({
      modelId: cfg.model,
      messages,
      ...(systemInstruction && systemInstruction.trim()
        ? { system: [{ text: systemInstruction.trim() }] }
        : {}),
      inferenceConfig: { maxTokens: maxOutputTokens, temperature },
    }),
  );

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
};
