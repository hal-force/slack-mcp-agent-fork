/**
 * Canvas skill — Slack canvas create/read/update via user OAuth token.
 */

const { FunctionDeclarationSchemaType } = require("@google-cloud/vertexai");
const { dispatchCanvasTool } = require("../canvas/userCanvasActions");

const T = FunctionDeclarationSchemaType;

const CANVAS_TOOL_NAMES = new Set(["slack_canvas_create", "slack_canvas_read", "slack_canvas_update"]);

const functionDeclarations = [
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
];

/**
 * Create a canvas skill instance bound to session-specific opts.
 * @param {{ userToken: string, defaultChannelId?: string|null, teamId?: string|null }} sessionOpts
 * @returns {{ name: string, functionDeclarations: object[], handlesToolName: (n: string) => boolean, dispatch: Function, isAvailable: (caps: object) => boolean }}
 */
function createCanvasSkill({ userToken, defaultChannelId = null, teamId = null }) {
  return {
    name: "canvas",
    functionDeclarations,
    handlesToolName: (name) => CANVAS_TOOL_NAMES.has(name),
    dispatch: (_name, args, _sessionOpts) =>
      dispatchCanvasTool(userToken, _name, args, {
        defaultChannelId: defaultChannelId || null,
        teamId: teamId || null,
      }),
    isAvailable: (caps) => !!caps.hasUserToken,
  };
}

module.exports = { createCanvasSkill };
