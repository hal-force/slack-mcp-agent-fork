/**
 * LLM provider abstraction.
 *
 * Two backends behind one `generateReply()` call:
 *  - "vertex"  (default): Vertex AI / Gemini via @google/genai.
 *  - "gateway": OpenAI-compatible /v1/chat/completions endpoint (used by the
 *               internal LLM gateway that serves Claude models).
 *
 * Select with AI_PROVIDER = "vertex" | "gateway". A gateway config that is
 * present but incomplete falls back to vertex so a misconfiguration never
 * silently breaks replies.
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
  return "vertex";
}

function gatewayConfig() {
  const url = String(process.env.LLM_GATEWAY_URL || "").trim();
  const apiKey = String(process.env.LLM_GATEWAY_API_KEY || "").trim();
  const model = String(process.env.LLM_GATEWAY_MODEL || "").trim();
  if (!url || !apiKey || !model) return null;
  return { url, apiKey, model };
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
  const out = await generateWithGemini({ ...req, modelId: opts.modelId });
  return { ...out, provider };
}

module.exports = {
  generateReply,
  selectedProvider,
  gatewayConfig,
  // exported for tests
  contentsToOpenAiMessages,
};
