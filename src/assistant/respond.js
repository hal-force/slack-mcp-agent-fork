const { VertexAI } = require("@google-cloud/vertexai");

const SYSTEM_PROMPT = `You are LivChat, a helpful AI assistant in Slack for employees of Lawrence Livermore National Laboratory.
- Be concise and clear. Use Slack-friendly formatting (e.g. *bold*, _italic_, lists).
- Keep Slack mentions as-is: <@USER_ID>, <#CHANNEL_ID>.
- If you use markdown, use Slack-compatible formatting.
- When the user provides "Slack context" (channel messages, search results, or thread content) in the conversation, you HAVE access to that content. Use it to answer (e.g. summarize, answer questions). Do not say you cannot access or read Slack channels when such context has been provided.
- If Slack context says there are no messages in recent history for a channel/thread, tell the user clearly that nothing showed up in what was fetched (empty channel, no recent text, etc.). Do not describe that as a permission or access problem unless the context explicitly indicates the app could not read the channel.
- Include citations with links to sources for information that is not common knowledge. Format citations like this: [^1]`;

let _model = null;

function getModel() {
  if (_model) return _model;
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location =
    process.env.VERTEX_LOCATION ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    "us-central1";
  const modelId = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (!project) {
    throw new Error("Missing GOOGLE_CLOUD_PROJECT. Set it in .env for Vertex/Gemini.");
  }
  const vertex = new VertexAI({ project, location });
  _model = vertex.getGenerativeModel({
    model: modelId,
    systemInstruction: {
      role: "system",
      parts: [{ text: SYSTEM_PROMPT }],
    },
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.7,
    },
  });
  return _model;
}

/**
 * Build Gemini contents array from Slack thread history + new user message.
 * Slack threadHistory items: { role: 'user'|'assistant', text: string }
 * Gemini roles: 'user' | 'model'
 * If slackContext is provided (MCP-style channel/thread/search), it is prepended to the final user turn.
 */
function buildContents(threadHistory, userMessage, slackContext) {
  const contents = [];
  if (Array.isArray(threadHistory) && threadHistory.length > 0) {
    for (const msg of threadHistory) {
      const role = msg.role === "assistant" ? "model" : "user";
      const text = (msg.text || "").trim();
      if (text) contents.push({ role, parts: [{ text }] });
    }
  }
  const trimmed = (userMessage || "").trim();
  if (trimmed) {
    const contextBlock = (slackContext && slackContext.trim())
      ? slackContext.trim() + "\n\n"
      : "";
    contents.push({ role: "user", parts: [{ text: contextBlock + trimmed }] });
  }
  return contents;
}

/**
 * Extract response text from Vertex generateContent result.
 */
function getTextFromResponse(response) {
  const candidate = response?.candidates?.[0];
  const part = candidate?.content?.parts?.[0];
  const text = part?.text?.trim();
  if (text) return text;
  if (candidate?.finishReason === "SAFETY") {
    return "I can't generate a response for that. Try rephrasing.";
  }
  return "I didn't get a valid response. Please try again.";
}

/**
 * Shared AI response via Vertex AI (Gemini).
 *
 * @param {Object} opts
 * @param {string} opts.userMessage - The user's message text
 * @param {Array<{role: string, text: string}>} [opts.threadHistory] - Optional thread history for context
 * @param {string} [opts.slackContext] - Optional Slack context (channel/thread/search, MCP-style) to ground answers
 * @returns {Promise<string>} Response text
 */
async function getAiResponse({ userMessage, threadHistory, slackContext }) {
  if (!userMessage || !userMessage.trim()) {
    return "Send me a message and I'll respond.";
  }

  try {
    const model = getModel();
    const contents = buildContents(threadHistory || [], userMessage.trim(), slackContext);
    if (contents.length === 0) return "Send me a message and I'll respond.";

    const result = await model.generateContent({ contents });
    const response = result.response;
    return getTextFromResponse(response);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Vertex/Gemini error:", err.message || err);
    }
    const msg = err.message || String(err);
    if (msg.includes("GOOGLE_CLOUD_PROJECT") || msg.includes("Could not load the default credentials")) {
      return "LivChat isn't configured for AI yet (check GOOGLE_CLOUD_PROJECT and Google auth).";
    }
    if (msg.includes("403") || msg.includes("PERMISSION_DENIED")) {
      return "AI service access isn't set up. Check Vertex AI permissions and billing.";
    }
    return "Something went wrong on my side. Please try again in a moment.";
  }
}

module.exports = { getAiResponse };
