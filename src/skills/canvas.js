/**
 * Canvas skill — Slack canvas create/read/update via user OAuth token.
 *
 * execute() runs BEFORE the LLM call:
 *   - read intent  → fetches canvas structure → injects as contextText
 *   - create intent → pre-creates an empty canvas → injects URL → returns canvas_update sideEffect
 *   - update intent → reads existing canvas → injects structure → returns canvas_update sideEffect
 *
 * dispatchSideEffects() in respond.js calls the Canvas API with the LLM-generated markdown after
 * the reply is produced.
 */

const { dispatchCanvasTool } = require("../canvas/userCanvasActions");

const SYSTEM_PROMPT_SECTION = `Slack Canvas Operations:
- A canvas has been pre-created or pre-read for this turn. Use the canvas context below when updating.
- Write your full canvas content as your reply—it will be automatically posted to the canvas.
- Include a clickable Slack link to the canvas at the end of your message using the URL from context (format: <URL|View Canvas>).
- Canvas links MUST use Slack format <URL|Display Text>. Never output raw file IDs (like F12345) as links.
- Do NOT delete canvases. Do not use replace_all unless the user explicitly wants a full rewrite.`;

const CANVAS_ID_RE = /\b(F[A-Z0-9]{6,})\b/i;
const CREATE_SIGNAL = /\b(create|make|start|new|draft)\b/i;
const READ_SIGNAL = /\b(read|show|list|sections|what('?s| is) in|open)\b/i;

function detectCanvasOp(userMessage, existingCanvasId) {
  if (!existingCanvasId) return "create";
  if (READ_SIGNAL.test(userMessage) && !CREATE_SIGNAL.test(userMessage)) return "read";
  return "update";
}

function formatCanvasReadContext(result, canvasId) {
  if (!result || result.ok === false) {
    return `\n--- Canvas context ---\n(Could not read canvas ${canvasId}: ${result?.error || "unknown error"})\n--- End Canvas context ---\n`;
  }
  const sections = Array.isArray(result.sections) ? result.sections : [];
  const sectionLines = sections.map((s) => `  id=${s.id || "?"} type=${s.type || "?"}: ${s.value || ""}`).join("\n");
  const urlNote = result.canvas_url ? `Canvas URL: ${result.canvas_url}\n` : "";
  return (
    `\n--- Canvas context (canvas_id: ${canvasId}) ---\n` +
    urlNote +
    (sectionLines ? `Sections:\n${sectionLines}\n` : "(no sections found)\n") +
    (result.note ? `Note: ${result.note}\n` : "") +
    `--- End Canvas context ---\n`
  );
}

function createCanvasSkill() {
  return {
    name: "canvas",
    matchesIntent: (intents) => Array.isArray(intents) && intents.includes("canvas"),
    isAvailable: (caps) => !!caps.hasUserToken,
    systemPromptSection: SYSTEM_PROMPT_SECTION,

    async execute({ userMessage, intents, sessionOpts }) {
      const { userToken, defaultChannelId = null, teamId = null } = sessionOpts;
      if (!userToken) return { contextText: "", uploads: [], sideEffects: [] };

      const canvasIdMatch = (userMessage || "").match(CANVAS_ID_RE);
      const canvasId = canvasIdMatch ? canvasIdMatch[1] : null;
      const op = detectCanvasOp(userMessage, canvasId);

      try {
        if (op === "read") {
          const result = await dispatchCanvasTool(
            userToken,
            "slack_canvas_read",
            { canvas_id: canvasId },
            { defaultChannelId, teamId },
          );
          return {
            contextText: formatCanvasReadContext(result, canvasId),
            uploads: [],
            sideEffects: [],
          };
        }

        if (op === "update" && canvasId) {
          const readResult = await dispatchCanvasTool(
            userToken,
            "slack_canvas_read",
            { canvas_id: canvasId },
            { defaultChannelId, teamId },
          );
          const contextText = formatCanvasReadContext(readResult, canvasId);
          const canvasUrl = readResult?.canvas_url || null;
          const urlNote = canvasUrl
            ? `\nCanvasURL for reply: ${canvasUrl}\nTell the user to view it at <${canvasUrl}|View Canvas>.`
            : "";
          return {
            contextText: contextText + urlNote,
            uploads: [],
            sideEffects: [{ type: "canvas_update", payload: { canvas_id: canvasId, mode: "append_end" } }],
          };
        }

        // create
        const createResult = await dispatchCanvasTool(
          userToken,
          "slack_canvas_create",
          { title: "", markdown: "", channel_id: defaultChannelId || undefined },
          { defaultChannelId, teamId },
        );
        if (!createResult || createResult.ok === false) {
          return { contextText: "", uploads: [], sideEffects: [] };
        }
        const newCanvasId = createResult.canvas_id;
        const canvasUrl = createResult.canvas_url || null;
        const urlNote = canvasUrl
          ? `\nCanvas URL: ${canvasUrl}\nEnd your reply with: <${canvasUrl}|View Canvas>`
          : "";
        const contextText =
          `\n--- Canvas context ---\n` +
          `A new Slack canvas has been pre-created (canvas_id: ${newCanvasId}).${urlNote}\n` +
          `Write the full canvas content in your reply as Slack mrkdwn — it will be automatically posted to the canvas.\n` +
          `--- End Canvas context ---\n`;
        return {
          contextText,
          uploads: [],
          sideEffects: [{ type: "canvas_update", payload: { canvas_id: newCanvasId, mode: "replace_all" } }],
        };
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.error("[CanvasSkill] execute error:", err.message || err);
        }
        return { contextText: "", uploads: [], sideEffects: [] };
      }
    },
  };
}

module.exports = { createCanvasSkill };
