const { dispatchCanvasTool } = require("../canvas/userCanvasActions");
const { generateReply, selectedProvider } = require("./llmProvider");
const {
  TABLEAU_TOOL_SPECS,
  dispatchTableauTool,
  tableauQueryToolsEnabled,
} = require("./tableauGeminiTools");

const BASE_SYSTEM_PROMPT = `Role: You are the Agency of the Future Slack Agent, a high-utility AI assistant.

1. Slack Formatting Rules (Mandatory)
- No Headers: Never use # for headers. Use BOLD ALL CAPS for section titles.
- Standard Markup: Use *bold*, _italics_, ~strikethrough~, and > blockquotes.
- Lists: Use standard bullet points (* or -).
- Tabular / multi-row data: **Never** use GitHub-style or pipe tables (rows of | col | col |). Slack does **not** render them—they appear as broken plain text. Instead use one bullet per row (e.g. *2015 · Q1 ·* *$74,447.80*) or short labeled lines (*Year:* 2015 *Quarter:* 1 *Revenue:* *$74,447.80*). Keep each row scannable.
- Links: Use ONLY the Slack format: <URL|Display Text>.
- Mentions: Keep <@USER_ID> and <#CHANNEL_ID> exactly as provided.
- Structure: Put a blank line between major sections (after each ALL CAPS title line and between distinct topics) so replies render with clear separation in Slack.

2. Handling Context — Priority Order
- FIRST — Slack workspace: The Slack context block (channel messages, threads, search results) is your primary source. Always answer from it when relevant. If Slack context is present but incomplete, say what you found before noting the gap. If context is entirely empty, state: "I don't see any recent messages for this."
- SECOND — Tableau data: For analytics questions, use the Tableau context (datasource list, metadata, query results, view images) as the secondary source.
- THIRD — Internet Search: Only invoke web search when (a) Slack and Tableau sources genuinely cannot answer the question, or (b) the user explicitly asks for current events, public documentation, or knowledge that wouldn't exist in the workspace.
- Citations: Use <URL|[1]> for external links (web results or Tableau URLs).

3. Error Handling
- If data is missing or tools errored, briefly explain why and ask for clarification. Do not apologize excessively.
- If the user asks about real-time data and internet search is not available, reply: "I don't have real-time web access right now. You can enable *Internet Search* in *App Home → Settings* so I can look this up for you."

4. Locale & Units
- When the context includes a *User locale* block, always use the unit system it specifies.
- If no locale block is present, default to metric units unless the user explicitly asks otherwise.

5. Response Depth & Reports
- Match the depth the user asks for. A quick question gets a concise answer. But when the user asks for a *report*, *brief*, *memo*, *analysis*, *deep dive*, *write-up*, *summary document*, or gives a length cue ("three pages", "detailed", "for my executive director"), produce a complete, well-structured long-form document written in narrative prose — NOT a bare list of statistics.
- A report must go beyond the numbers: open with an EXECUTIVE SUMMARY, use clearly titled sections (BOLD ALL CAPS), and for each section explain what the data *means* — trends, drivers, comparisons, outliers, risks or caveats, and (where useful) recommendations or next steps. Interpret the "so what," don't just enumerate figures.
- You have a large output budget. Never compress, truncate, or drop analysis to save space when depth is requested — favor completeness, clear reasoning, and full explanations. Write to the requested length.
- These depth rules layer on top of the Slack formatting rules above: still use BOLD ALL CAPS section titles, bullets (never pipe tables), and blank lines between sections. When a Slack Canvas has been pre-created for this turn, write the full report as your reply so it lands in the canvas as a proper multi-section document.`;

/**
 * @param {string} text
 * @param {Array<{ buffer: Buffer, filename: string, title?: string }>} [uploads]
 * @returns {{ text: string, uploads: Array<{ buffer: Buffer, filename: string, title?: string }> }}
 */
function aiReply(text, uploads = []) {
  return { text: text || "", uploads: uploads || [] };
}

function getPrimaryModelId() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function selectModelId(useFullModel) {
  const fast = process.env.GEMINI_FAST_MODEL;
  if (!fast || useFullModel) return getPrimaryModelId();
  return fast;
}

function buildContents(threadHistory, userMessage, skillContext) {
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
    const contextBlock = skillContext && skillContext.trim() ? skillContext.trim() + "\n\n" : "";
    contents.push({ role: "user", parts: [{ text: contextBlock + trimmed }] });
  }
  return contents;
}

/**
 * Dispatch canvas side effects after the LLM reply is produced.
 * Returns any supplementary text to append (e.g., canvas URL confirmation).
 *
 * @param {Array<{type: string, payload: object}>} sideEffects
 * @param {string} llmReplyText
 * @param {{ userToken?: string, defaultChannelId?: string|null, teamId?: string|null }} opts
 */
async function dispatchSideEffects(sideEffects, llmReplyText, opts = {}) {
  if (!sideEffects?.length) return;
  const { userToken, defaultChannelId = null, teamId = null } = opts;
  if (!userToken) return;

  await Promise.all(
    sideEffects.map(async (se) => {
      if (se.type === "canvas_update") {
        try {
          await dispatchCanvasTool(
            userToken,
            "slack_canvas_update",
            {
              canvas_id: se.payload.canvas_id,
              markdown: llmReplyText,
              mode: se.payload.mode || "replace_all",
            },
            { defaultChannelId, teamId },
          );
        } catch (err) {
          if (process.env.NODE_ENV !== "production") {
            console.error("[dispatchSideEffects] canvas_update error:", err?.message || err);
          }
        }
      }
    }),
  );
}

/**
 * @param {string} userMessage
 * @param {object} opts
 * @param {Array<{role: string, text: string}>} [opts.threadHistory]
 * @param {string} [opts.skillContext] - pre-assembled context from executeActiveSkills()
 * @param {Array<{buffer: Buffer, filename: string, title?: string}>} [opts.uploads] - from skills
 * @param {Array<{type: string, payload: object}>} [opts.sideEffects] - from skills
 * @param {boolean} [opts.googleSearchActive]
 * @param {string[]} [opts.systemPromptSections] - per-skill prompt sections
 * @param {string} [opts.userToken] - xoxp- for canvas side effects
 * @param {string|null} [opts.defaultCanvasChannelId]
 * @param {string|null} [opts.teamId]
 * @param {boolean} [opts.useFullModel]
 * @returns {Promise<{ text: string, uploads: Array<{ buffer: Buffer, filename: string, title?: string }> }>}
 */
async function getAiResponse({
  userMessage,
  threadHistory,
  skillContext,
  uploads = [],
  sideEffects = [],
  googleSearchActive = false,
  systemPromptSections = [],
  userToken,
  defaultCanvasChannelId,
  teamId,
  useFullModel = false,
  tableauMcpBaseUrl,
}) {
  if (!userMessage || !userMessage.trim()) {
    return aiReply("Send me a message and I'll respond.");
  }

  const provider = selectedProvider();
  // Force primary model when internet search is active — fast model may not support grounding.
  // (Model id only applies to the Vertex/Gemini backend.)
  const modelId = googleSearchActive ? getPrimaryModelId() : selectModelId(useFullModel);

  // googleSearch grounding is a Gemini-only tool. Under the gateway (Claude) it is unavailable,
  // so don't advertise it to the model on that backend.
  const searchActive = googleSearchActive && provider === "vertex";

  // Assemble system prompt: base + per-skill sections.
  const systemInstruction =
    systemPromptSections.length > 0
      ? BASE_SYSTEM_PROMPT + "\n\n---\n\n" + systemPromptSections.join("\n\n")
      : BASE_SYSTEM_PROMPT;

  // When internet search is active, inject a note so the model uses it.
  let effectiveContext = skillContext || "";
  if (searchActive) {
    const searchNote =
      "[Internet Search is ACTIVE this turn — use Google Search immediately for any real-time, current-events, weather, price, or factual look-up that needs live data. Do not say you lack web access.]";
    effectiveContext = searchNote + (effectiveContext ? "\n\n" + effectiveContext : "");
  }

  const contents = buildContents(threadHistory || [], userMessage.trim(), effectiveContext);
  if (contents.length === 0) return aiReply("Send me a message and I'll respond.");

  const maxOutputTokens = Number(process.env.LLM_MAX_OUTPUT_TOKENS) ||
    Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 4096;

  // Live Tableau MCP tool calling. When the app runs on Bedrock and a Tableau
  // MCP server is configured, expose the query/metadata/list/view tools so the
  // model can actually pull and analyze data in-turn (list-datasources →
  // get-datasource-metadata → query-datasource, or list-views → get-view-image)
  // rather than only seeing the pre-fetched context block. View images the tools
  // render are queued here and returned as Slack uploads.
  const toolUploads = [];
  let tools;
  let dispatchTool;
  if (provider === "bedrock" && tableauQueryToolsEnabled({ tableauMcpBaseUrl })) {
    tools = TABLEAU_TOOL_SPECS;
    const toolOpts = {
      tableauMcpBaseUrl,
      uploadQueue: toolUploads,
      datasourceUrlByLuid: {},
      viewUrlById: {},
    };
    dispatchTool = (name, input) => dispatchTableauTool(name, input, toolOpts);
  }

  try {
    const result = await generateReply(
      {
        systemInstruction,
        contents,
        maxOutputTokens,
        temperature: 0.7,
        googleSearchActive: searchActive,
        tools,
        dispatchTool,
      },
      { modelId },
    );

    // View images rendered by in-turn tool calls are posted alongside any
    // uploads the skills already produced.
    const allUploads = toolUploads.length ? [...uploads, ...toolUploads] : uploads;

    if (result.safety) {
      return aiReply("I can't generate a response for that. Try rephrasing.", allUploads);
    }

    let text = result.text;
    if (text && result.truncated) {
      // The model hit the output-token cap. Flag it so the user knows the reply is cut,
      // rather than silently ending mid-thought (a source of "truncated response" reports).
      text += "\n\n_…(response truncated — ask me to continue for the rest.)_";
    }

    const finalText = text || (allUploads.length > 0
      ? allUploads.length === 1
        ? "Here's a Tableau view snapshot—see the image file below this message."
        : `Here are ${allUploads.length} Tableau view snapshots—see the image files below this message.`
      : "I didn't get a clear response. Please try again.");

    // Dispatch canvas side effects with the LLM's reply as the canvas content.
    if (sideEffects.length > 0) {
      await dispatchSideEffects(sideEffects, finalText, {
        userToken,
        defaultChannelId: defaultCanvasChannelId || null,
        teamId: teamId || null,
      });
    }

    return aiReply(finalText, allUploads);
  } catch (err) {
    console.error(`LLM error (${provider}):`, err.message || err);
    const msg = err.message || String(err);
    if (msg.includes("GOOGLE_CLOUD_PROJECT") || msg.includes("Could not load the default credentials")) {
      return aiReply(
        "slack-mcp-agent isn't configured for AI yet (check GOOGLE_CLOUD_PROJECT and Google auth).",
        uploads,
      );
    }
    if (msg.includes("LLM gateway")) {
      return aiReply("The AI gateway is unavailable right now. Please try again in a moment.", uploads);
    }
    if (
      provider === "bedrock" ||
      msg.includes("Bedrock") ||
      msg.includes("ExpiredToken") ||
      msg.includes("UnrecognizedClient") ||
      msg.includes("security token")
    ) {
      return aiReply(
        "The AI service (AWS Bedrock) is unavailable right now — its credentials may have expired. Please try again shortly.",
        uploads,
      );
    }
    if (msg.includes("403") || msg.includes("PERMISSION_DENIED")) {
      return aiReply("AI service access isn't set up. Check Vertex AI permissions and billing.", uploads);
    }
    return aiReply("Something went wrong on my side. Please try again in a moment.", uploads);
  }
}

module.exports = { getAiResponse };
