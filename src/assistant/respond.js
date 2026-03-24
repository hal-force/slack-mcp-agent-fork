const { VertexAI, FunctionCallingMode, FunctionDeclarationSchemaType } = require("@google-cloud/vertexai");
const { dispatchCanvasTool } = require("../canvas/userCanvasActions");
const {
  TABLEAU_FUNCTION_DECLARATIONS,
  isTableauGeminiTool,
  dispatchTableauTool,
  tableauQueryToolsEnabled,
} = require("./tableauGeminiTools");

const SYSTEM_PROMPT = `Role: You are the Agency of the Future Slack Agent, a high-utility AI assistant.

1. Slack Formatting Rules (Mandatory)
- No Headers: Never use # for headers. Use BOLD ALL CAPS for section titles.
- Standard Markup: Use *bold*, _italics_, ~strikethrough~, and > blockquotes.
- Lists: Use standard bullet points (* or -).
- Links: Use ONLY the Slack format: <URL|Display Text>.
- Mentions: Keep <@USER_ID> and <#CHANNEL_ID> exactly as provided.

2. Handling Context (Slack & Tableau)
- Slack Context: Prioritize provided channel messages/threads over general knowledge. If context is empty, state: "I don't see any recent messages for this."
- Citations: Use <URL|[1]> for external links.
- Tableau: Use exact field names from metadata. If metadata is present, explain it immediately—do not ask the user for permission to "fetch" it. If the context includes *Closest published data sources* with scores, map the user’s wording to the best LUID or confirm with them before calling metadata/query tools. If data is missing, suggest specific metrics they should ask for.

3. Slack Canvas Operations
- Update strategy: Prefer *targeted* edits when the user wants to change one part: call slack_canvas_read to get section id values from each sections[] entry, then slack_canvas_update with insert_after, insert_before, or replace_section plus that section_id. Use insert_start / append_end for adding at top or bottom without a section anchor. Use replace_all only when the user wants the *entire* document rewritten from scratch.
- Canvas links: You MUST output links as <URL|View Canvas>. Never output a raw canvas file ID like F12345 as if it were a link.
- Reading canvases: Tool results list section IDs (not full body text). Use those IDs for partial updates. Never guess body text that is not in the tool response.
- Safety: Do not delete canvases (no delete operation).

4. Tableau data (when tools are available)
- Same flow as Claude + Tableau MCP: list → metadata → **query-datasource** via tableau_query_datasource. Always use **fieldCaption** strings exactly from metadata; for measures add **function** (e.g. SUM, AVG). Pass optional **limit** on queries that could return many rows.
- If a query fails for format reasons, simplify: fewer fields, check captions, then retry. Quote the server error briefly when explaining to the user.
- Ground numeric answers in tool output only. If a query errors or returns empty, say so—do not invent figures.

5. Error Handling
- If a tool call fails, briefly explain why (e.g., "I couldn't find a canvas with that ID") and ask for clarification. Do not apologize excessively.`;

const T = FunctionDeclarationSchemaType;

const CANVAS_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "slack_canvas_create",
        description:
          "Create a Slack canvas for the user. Use when they ask to create, add, or start a canvas or doc. For workspaces that require a channel tab, pass channel_id (defaults to the current conversation if omitted). The tool response includes canvas_url and slack_mrkdwn_link_example for posting a clickable Slack link.",
        parameters: {
          type: T.OBJECT,
          properties: {
            title: { type: T.STRING, description: "Optional title." },
            markdown: { type: T.STRING, description: "Initial markdown body." },
            channel_id: {
              type: T.STRING,
              description: "Optional channel ID (C…) to tab the canvas in; defaults to current conversation.",
            },
          },
        },
      },
      {
        name: "slack_canvas_read",
        description:
          "Read canvas structure: returns heading sections and IDs via Slack API. Use when the user wants to inspect, list sections, or locate a canvas. Does not return full markdown body. Response includes canvas_url for a clickable client link.",
        parameters: {
          type: T.OBJECT,
          properties: {
            canvas_id: { type: T.STRING, description: "Canvas ID such as F0123ABCD." },
            contains_text: {
              type: T.STRING,
              description: "Optional filter: headings containing this text.",
            },
          },
          required: ["canvas_id"],
        },
      },
      {
        name: "slack_canvas_update",
        description:
          "Update a canvas. Use slack_canvas_read first to obtain section_id values for heading blocks. Modes: insert_after / insert_before / replace_section require section_id. insert_start and append_end add content at top or bottom. replace_all rewrites the whole canvas. Never delete. Response includes canvas_url.",
        parameters: {
          type: T.OBJECT,
          properties: {
            canvas_id: { type: T.STRING },
            markdown: { type: T.STRING, description: "Markdown content to insert or to replace a section with." },
            section_id: {
              type: T.STRING,
              description:
                "Required for insert_after, insert_before, replace_section. From slack_canvas_read sections[].id (e.g. temp:C:…).",
            },
            mode: {
              type: T.STRING,
              enum: [
                "append_end",
                "replace_all",
                "insert_start",
                "insert_after",
                "insert_before",
                "replace_section",
              ],
              description:
                "append_end=end; insert_start=top; replace_all=whole doc; insert_after/before/replace_section need section_id.",
            },
          },
          required: ["canvas_id", "markdown", "mode"],
        },
      },
    ],
  },
];

const MAX_TOOL_ROUNDS = 5;

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
      maxOutputTokens: 2048,
      temperature: 0.7,
    },
  });
  return _model;
}

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
    const contextBlock = slackContext && slackContext.trim() ? slackContext.trim() + "\n\n" : "";
    contents.push({ role: "user", parts: [{ text: contextBlock + trimmed }] });
  }
  return contents;
}

function getTextFromCandidate(candidate) {
  const parts = candidate?.content?.parts || [];
  const texts = parts.filter((p) => p.text).map((p) => p.text);
  return texts.join("").trim();
}

function getModelParts(candidate) {
  return candidate?.content?.parts || [];
}

function getFunctionCallParts(parts) {
  return parts.filter((p) => p.functionCall);
}

/**
 * @param {string} userMessage
 * @param {object} opts
 * @param {Array<{role: string, text: string}>} [opts.threadHistory]
 * @param {string} [opts.slackContext]
 * @param {string} [opts.userToken] - xoxp- for canvas tools
 * @param {string|null} [opts.defaultCanvasChannelId] - C… for default canvas tab
 * @param {string|null} [opts.teamId] - T… workspace team id for building canvas client URLs
 */
async function getAiResponse({ userMessage, threadHistory, slackContext, userToken, defaultCanvasChannelId, teamId }) {
  if (!userMessage || !userMessage.trim()) {
    return "Send me a message and I'll respond.";
  }

  const model = getModel();
  const contents = buildContents(threadHistory || [], userMessage.trim(), slackContext);
  if (contents.length === 0) return "Send me a message and I'll respond.";

  const useCanvasTools = !!(userToken && String(userToken).trim());
  const useTableauTools = tableauQueryToolsEnabled();
  const mergedDeclarations = [];
  if (useCanvasTools) mergedDeclarations.push(...CANVAS_TOOLS[0].functionDeclarations);
  if (useTableauTools) mergedDeclarations.push(...TABLEAU_FUNCTION_DECLARATIONS);
  const tools =
    mergedDeclarations.length > 0 ? [{ functionDeclarations: mergedDeclarations }] : undefined;
  const toolConfig =
    mergedDeclarations.length > 0
      ? { functionCallingConfig: { mode: FunctionCallingMode.AUTO } }
      : undefined;

  let working = contents;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await model.generateContent({
        contents: working,
        tools,
        toolConfig,
      });
      const response = result.response;
      const candidate = response?.candidates?.[0];
      if (!candidate) {
        return "I didn't get a valid response. Please try again.";
      }

      if (candidate.finishReason === "SAFETY") {
        return "I can't generate a response for that. Try rephrasing.";
      }

      const modelParts = getModelParts(candidate);
      const fcParts = getFunctionCallParts(modelParts);
      if (fcParts.length === 0) {
        const text = getTextFromCandidate(candidate);
        return text || "I didn't get a clear response. Please try again.";
      }

      working.push({
        role: "model",
        parts: modelParts,
      });

      const responseParts = [];
      for (const p of fcParts) {
        const fc = p.functionCall;
        const name = fc.name;
        const args = fc.args && typeof fc.args === "object" ? { ...fc.args } : {};
        let toolResult;
        if (isTableauGeminiTool(name)) {
          toolResult = await dispatchTableauTool(name, args);
        } else if (useCanvasTools) {
          toolResult = await dispatchCanvasTool(userToken, name, args, {
            defaultChannelId: defaultCanvasChannelId || null,
            teamId: teamId || null,
          });
        } else {
          toolResult = { ok: false, error: "No handler for this tool in the current session." };
        }
        responseParts.push({
          functionResponse: {
            name,
            response: { name, content: toolResult },
          },
        });
      }

      working.push({ role: "user", parts: responseParts });
    }

    return "I hit the limit for tool steps in one turn. Please narrow your request.";
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Vertex/Gemini error:", err.message || err);
    }
    const msg = err.message || String(err);
    if (msg.includes("GOOGLE_CLOUD_PROJECT") || msg.includes("Could not load the default credentials")) {
      return "slack-mcp-agent isn't configured for AI yet (check GOOGLE_CLOUD_PROJECT and Google auth).";
    }
    if (msg.includes("403") || msg.includes("PERMISSION_DENIED")) {
      return "AI service access isn't set up. Check Vertex AI permissions and billing.";
    }
    return "Something went wrong on my side. Please try again in a moment.";
  }
}

module.exports = { getAiResponse };
