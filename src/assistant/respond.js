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
- Tabular / multi-row data: **Never** use GitHub-style or pipe tables (rows of | col | col |). Slack does **not** render them—they appear as broken plain text. Instead use one bullet per row (e.g. *2015 · Q1 ·* *$74,447.80*) or short labeled lines (*Year:* 2015 *Quarter:* 1 *Revenue:* *$74,447.80*). Keep each row scannable.
- Links: Use ONLY the Slack format: <URL|Display Text>.
- Mentions: Keep <@USER_ID> and <#CHANNEL_ID> exactly as provided.
- Structure: Put a blank line between major sections (after each ALL CAPS title line and between distinct topics) so replies render with clear separation in Slack.

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
- **PNG snapshots first for visual analytics:** When the user asks for revenue, trends, quarters, KPIs, dashboards, charts, or anything that is normally shown on a Tableau sheet, you should deliver a **PNG of a real published view** in Slack—not only text. Flow: (1) **tableau_list_views** with a **filter** when helpful (Tableau REST filter form field:operator:value on views—e.g. name:eq:Overview, or wildcards on supported servers like name:eq:*Sales*, workbookName:eq:*Superstore*); (2) **tableau_get_view_image** with that **view_id**, **format PNG**, and **width 1400**, **height 900** (or 1200×800) so the image is readable in Slack. The file is uploaded automatically **below** your message. **Always** follow tool calls with at least one or two sentences in your *final* reply (dashboard name, why it fits the question)—never end the turn with only empty text after get_view_image.
- **Exact numbers:** You may **also** use list → metadata → **tableau_query_datasource** for precise figures. Use **fieldCaption** from metadata; for measures set **function** (SUM, AVG, etc.). Prefer bullets for multi-row results (rule 1). A PNG plus a short numeric summary is better than numbers alone when a matching view exists.
- If **list_views** returns many hits, pick the best match (name/workbook vs user wording) for **get_view_image**; if unsure, try the clearest dashboard or overview view.
- If a query fails for format reasons, simplify fields/captions and retry. Quote server errors briefly.
- Ground numbers in tool output only. If tools error or return empty, say so—do not invent figures.

5. Error Handling
- If a tool call fails, briefly explain why (e.g., "I couldn't find a canvas with that ID") and ask for clarification. Do not apologize excessively.

6. Locale & Units
- When the context includes a *User locale* block, always use the unit system it specifies for all measurements (Celsius vs Fahrenheit, km vs miles, kg vs pounds, etc.).
- If no locale block is present, default to metric units unless the user explicitly asks otherwise.`;

/** Reserved for a restricted workflow mode; the live Ask AI step uses the main chat system prompt and tools. */
const WORKFLOW_SYSTEM_PROMPT = `Role: You are the Agency of the Future Slack Agent, answering a task from Slack Workflow Builder.

1. Scope
- You have the workflow prompt and any **Slack context** block appended below (a snapshot of recent messages from channels referenced as <#C…> in the prompt). That snapshot is all the live Slack data you get for this run—treat it as read-only; you cannot open new channels, threads, or tools.
- You do NOT have canvases, Tableau, search beyond that snapshot, or any tool calls. If the task needs data that is not in the prompt or the Slack context block, say what is missing and what a prior workflow step would need to pass in.

2. Slack formatting (output contract)
- Output must be a single string using Slack mrkdwn. NOT GitHub markdown, NOT HTML.
- Bold: *text* (single asterisk only — never **double**)
- Italic: _text_
- Strikethrough: ~text~
- Blockquote: > text
- Bullet points: Use • (bullet character). Never use * or - as list markers — they conflict with bold/italic syntax.
- Section titles: *BOLD ALL CAPS* — never use # headers.
- Links: ONLY the format <https://example.com|Display Text> — no raw URLs, no [text](url), no HTML anchors. The URL must be clean with no trailing commas, filenames, or extra characters before the pipe.
- Channels: <#CHANNEL_ID> format (e.g. <#C012AB3CD>)
- People: Use display names as shown in context (e.g. *Alex Thompson*) — never paste raw U… user ID codes.
- Line breaks: Use a single newline \n between elements. No blank lines between bullet points.
- Do not wrap the output in code fences, quotes, or any container. Return the mrkdwn string directly.

3. Tone
- Confident (never cocky)
- Witty (but never silly)
- Conversational (but always appropriate and respectful)
- Intelligent (and we always treat our users as intelligent too)
- Friendly (but not ingratiating)
- Helpful (never overbearing)
- Clear, concise and human`;

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

/** Nudge when Gemini ends a turn with no text after tools—avoids showing a false “try again” to users. */
const EMPTY_FINAL_RECOVERY_USER_TEXT =
  "Your previous assistant turn had no user-visible text. Write the **final** Slack mrkdwn answer now: use the user's question, the conversation, and any tool/function results above—especially numbers and breakdowns. Follow the system Slack formatting rules. Do **not** call tools; only output the reply the user should read.";

/**
 * One follow-up generateContent without tools when the model stops with empty text (common after tool rounds).
 * @param {*} model - Vertex GenerativeModel
 * @param {Array<{ role: string, parts: unknown[] }>} workingContents
 * @param {unknown[]} emptyTurnModelParts from the empty final candidate
 * @returns {Promise<string|null>}
 */
async function recoverEmptyFinalText(model, workingContents, emptyTurnModelParts) {
  const modelTurn =
    Array.isArray(emptyTurnModelParts) && emptyTurnModelParts.length > 0
      ? { role: "model", parts: emptyTurnModelParts }
      : { role: "model", parts: [{ text: "" }] };
  const recoveryContents = [
    ...workingContents,
    modelTurn,
    { role: "user", parts: [{ text: EMPTY_FINAL_RECOVERY_USER_TEXT }] },
  ];
  const result = await model.generateContent({ contents: recoveryContents });
  const candidate = result.response?.candidates?.[0];
  if (!candidate || candidate.finishReason === "SAFETY") return null;
  const parts = getModelParts(candidate);
  if (getFunctionCallParts(parts).length > 0) return null;
  const t = getTextFromCandidate(candidate);
  return t.trim() ? t : null;
}

/**
 * @param {string} text
 * @param {Array<{ buffer: Buffer, filename: string, title?: string }>} [uploads]
 * @returns {{ text: string, uploads: Array<{ buffer: Buffer, filename: string, title?: string }> }}
 */
function aiReply(text, uploads = []) {
  return { text: text || "", uploads: uploads || [] };
}

/**
 * Gemini sometimes returns no text after tool rounds even when uploads were queued (e.g. after get_view_image).
 * Avoid telling the user the run failed when a snapshot was produced.
 * @param {string} text
 * @param {Array<unknown>} uploadQueue
 * @returns {string}
 */
function resolveFinalAssistantText(text, uploadQueue) {
  const t = (text || "").trim();
  if (t) return t;
  if (uploadQueue?.length) {
    const n = uploadQueue.length;
    return n === 1
      ? "Here's a Tableau view snapshot—see the image file below this message."
      : `Here are ${n} Tableau view snapshots—see the image files below this message.`;
  }
  return "I didn't get a clear response. Please try again.";
}

let _chatModel = null;
let _fastChatModel = null;
let _workflowModel = null;

const TOOL_SIGNAL_RE = /tableau|canvas|datasource|dashboard|query|viz|view|workbook/i;

function createGenerativeModel(systemPromptText, modelIdOverride) {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location =
    process.env.VERTEX_LOCATION ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    "us-central1";
  const modelId = modelIdOverride || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (!project) {
    throw new Error("Missing GOOGLE_CLOUD_PROJECT. Set it in .env for Vertex/Gemini.");
  }
  const vertex = new VertexAI({ project, location });
  return vertex.getGenerativeModel({
    model: modelId,
    systemInstruction: {
      role: "system",
      parts: [{ text: systemPromptText }],
    },
    generationConfig: {
      maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 1024,
      temperature: 0.7,
    },
  });
}

function getChatModel() {
  if (!_chatModel) _chatModel = createGenerativeModel(SYSTEM_PROMPT);
  return _chatModel;
}

function getFastChatModel() {
  const fastModelId = process.env.GEMINI_FAST_MODEL;
  if (!fastModelId) return getChatModel();
  if (!_fastChatModel) _fastChatModel = createGenerativeModel(SYSTEM_PROMPT, fastModelId);
  return _fastChatModel;
}

function getWorkflowModel() {
  if (!_workflowModel) _workflowModel = createGenerativeModel(WORKFLOW_SYSTEM_PROMPT);
  return _workflowModel;
}

/**
 * Select the appropriate model based on query complexity signals.
 * Routes to a fast model (GEMINI_FAST_MODEL) for conversational queries with no tool indicators.
 */
function selectChatModel(userMessage) {
  if (!process.env.GEMINI_FAST_MODEL) return getChatModel();
  if (TOOL_SIGNAL_RE.test(userMessage)) return getChatModel();
  return getFastChatModel();
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
 * @param {string} [opts.tableauMcpBaseUrl] - optional per-user Tableau MCP base URL override
 * @param {Record<string, string>} [opts.datasourceUrls] - LUID (lowercase) → Tableau browse URL from buildTableauContext
 * @param {boolean} [opts.workflowStep] - if true, use workflow-only system prompt and disable all tools
 * @returns {Promise<{ text: string, uploads: Array<{ buffer: Buffer, filename: string, title?: string }> }>}
 */
async function getAiResponse({
  userMessage,
  threadHistory,
  slackContext,
  userToken,
  defaultCanvasChannelId,
  teamId,
  tableauMcpBaseUrl,
  datasourceUrls,
  workflowStep = false,
}) {
  if (!userMessage || !userMessage.trim()) {
    return aiReply("Send me a message and I'll respond.");
  }

  const model = workflowStep ? getWorkflowModel() : selectChatModel(userMessage);
  const contents = buildContents(threadHistory || [], userMessage.trim(), slackContext);
  if (contents.length === 0) return aiReply("Send me a message and I'll respond.");

  const useCanvasTools = !workflowStep && !!(userToken && String(userToken).trim());
  const useTableauTools = !workflowStep && tableauQueryToolsEnabled({ tableauMcpBaseUrl });
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
  /** @type {Array<{ buffer: Buffer, filename: string, title?: string }>} */
  const uploadQueue = [];
  const datasourceUrlByLuid = { ...(datasourceUrls && typeof datasourceUrls === "object" ? datasourceUrls : {}) };
  const viewUrlById = {};

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
        const msg =
          uploadQueue?.length > 0
            ? "I couldn't finish the written reply, but see the Tableau file(s) below if any were attached."
            : "I didn't get a valid response. Please try again.";
        return aiReply(msg, uploadQueue);
      }

      if (candidate.finishReason === "SAFETY") {
        return aiReply("I can't generate a response for that. Try rephrasing.", uploadQueue);
      }

      const modelParts = getModelParts(candidate);
      const fcParts = getFunctionCallParts(modelParts);
      if (fcParts.length === 0) {
        let text = getTextFromCandidate(candidate);
        if (!text.trim() && uploadQueue.length === 0) {
          try {
            const recovered = await recoverEmptyFinalText(model, working, modelParts);
            if (recovered) text = recovered;
          } catch (recoveryErr) {
            if (process.env.NODE_ENV !== "production") {
              console.error("Empty-final recovery generateContent failed:", recoveryErr?.message || recoveryErr);
            }
          }
        }
        return aiReply(resolveFinalAssistantText(text, uploadQueue), uploadQueue);
      }

      working.push({
        role: "model",
        parts: modelParts,
      });

      // Dispatch all tool calls in this round concurrently. JS is single-threaded so
      // mutations to uploadQueue/datasourceUrlByLuid/viewUrlById are safe — only I/O overlaps.
      const responseParts = await Promise.all(
        fcParts.map(async (p) => {
          const fc = p.functionCall;
          const name = fc.name;
          const args = fc.args && typeof fc.args === "object" ? { ...fc.args } : {};
          let toolResult;
          if (isTableauGeminiTool(name)) {
            toolResult = await dispatchTableauTool(name, args, {
              tableauMcpBaseUrl,
              uploadQueue,
              datasourceUrlByLuid,
              viewUrlById,
            });
          } else if (useCanvasTools) {
            toolResult = await dispatchCanvasTool(userToken, name, args, {
              defaultChannelId: defaultCanvasChannelId || null,
              teamId: teamId || null,
            });
          } else {
            toolResult = { ok: false, error: "No handler for this tool in the current session." };
          }
          return {
            functionResponse: {
              name,
              response: { name, content: toolResult },
            },
          };
        })
      );

      working.push({ role: "user", parts: responseParts });
    }

    const limitMsg =
      uploadQueue?.length > 0
        ? "I hit the tool-step limit for one message—try a narrower ask. Any Tableau snapshot(s) we already rendered are attached below."
        : "I hit the limit for tool steps in one turn. Please narrow your request.";
    return aiReply(limitMsg, uploadQueue);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Vertex/Gemini error:", err.message || err);
    }
    const msg = err.message || String(err);
    if (msg.includes("GOOGLE_CLOUD_PROJECT") || msg.includes("Could not load the default credentials")) {
      return aiReply(
        "slack-mcp-agent isn't configured for AI yet (check GOOGLE_CLOUD_PROJECT and Google auth).",
        uploadQueue,
      );
    }
    if (msg.includes("403") || msg.includes("PERMISSION_DENIED")) {
      return aiReply("AI service access isn't set up. Check Vertex AI permissions and billing.", uploadQueue);
    }
    return aiReply("Something went wrong on my side. Please try again in a moment.", uploadQueue);
  }
}

module.exports = { getAiResponse };
