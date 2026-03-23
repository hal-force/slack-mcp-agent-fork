/**
 * Slack canvas operations using the installing user's OAuth token (xoxp-).
 * Uses canvases.create, canvases.sections.lookup, canvases.edit only (no delete).
 */

const { WebClient } = require("@slack/web-api");

/**
 * Web URL to open a canvas in the Slack client (team_id T…, canvas_id F…).
 * @see https://api.slack.com/reference/deep-linking#client_urls
 */
function buildSlackCanvasWebUrl(teamId, canvasId) {
  const tid = String(teamId || "").trim();
  const cid = String(canvasId || "").trim();
  if (!tid || !cid) return null;
  return `https://app.slack.com/client/${encodeURIComponent(tid)}/${encodeURIComponent(cid)}`;
}

/** Append open-in-Slack URL + mrkdwn example for the model. */
function enrichCanvasToolResult(result, teamId) {
  if (!result || result.ok !== true || !result.canvas_id) return result;
  const canvas_url = buildSlackCanvasWebUrl(teamId, result.canvas_id);
  if (!canvas_url) return { ...result, canvas_link_note: "No team_id in context; share canvas_id as plain text." };
  const titleHint = (result.title && String(result.title)) || "Open canvas";
  return {
    ...result,
    canvas_url,
    slack_mrkdwn_link_example: `<${canvas_url}|${titleHint.replace(/\|/g, "/")}>`,
  };
}

function userWebClient(userToken) {
  if (!userToken || typeof userToken !== "string" || !userToken.trim()) {
    throw new Error("User token is required for canvas actions.");
  }
  return new WebClient(userToken.trim());
}

/**
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ title?: string, markdown?: string, channel_id?: string }} args
 */
async function canvasCreate(client, args) {
  const markdown = (args.markdown || "").trim();
  const payload = {};
  if (args.title && String(args.title).trim()) payload.title = String(args.title).trim();
  if (markdown) {
    payload.document_content = { type: "markdown", markdown };
  }
  if (args.channel_id && String(args.channel_id).trim()) {
    payload.channel_id = String(args.channel_id).trim();
  }
  const res = await client.canvases.create(payload);
  if (!res.ok) {
    return { ok: false, error: res.error, detail: res.detail || res.response_metadata };
  }
  return { ok: true, canvas_id: res.canvas_id, title: args.title || null };
}

/**
 * Reads canvas structure via section lookup (Slack does not expose full markdown export on this API).
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ canvas_id: string, contains_text?: string }} args
 */
async function canvasRead(client, args) {
  const canvas_id = String(args.canvas_id || "").trim();
  if (!canvas_id) return { ok: false, error: "canvas_id_required" };

  const criteria = { section_types: ["any_header"] };
  const ct = (args.contains_text || "").trim();
  if (ct) criteria.contains_text = ct;

  const res = await client.canvases.sections.lookup({ canvas_id, criteria });
  if (!res.ok) {
    return { ok: false, error: res.error };
  }
  return {
    ok: true,
    canvas_id,
    sections: res.sections || [],
    note:
      "Slack returns section `id` values for headings (e.g. temp:C:…). Use those IDs with slack_canvas_update modes insert_after, insert_before, or replace_section. For whole-document changes use append_end or replace_all. This API does not return full canvas markdown.",
  };
}

/**
 * @param {import('@slack/web-api').WebClient} client
 * @param {{
 *   canvas_id: string,
 *   markdown: string,
 *   mode: 'append_end'|'replace_all'|'insert_after'|'insert_before'|'replace_section'|'insert_start',
 *   section_id?: string,
 * }} args
 */
async function canvasUpdate(client, args) {
  const canvas_id = String(args.canvas_id || "").trim();
  const markdown = String(args.markdown || "");
  const raw = String(args.mode || "append_end")
    .toLowerCase()
    .replace(/-/g, "_");
  const mode =
    raw === "replace_all" ||
    raw === "insert_after" ||
    raw === "insert_before" ||
    raw === "replace_section" ||
    raw === "insert_start"
      ? raw
      : "append_end";

  if (!canvas_id) return { ok: false, error: "canvas_id_required" };
  if (!markdown.trim()) return { ok: false, error: "markdown_required" };

  const section_id = String(args.section_id || "").trim();
  const document_content = { type: "markdown", markdown };

  /** @type {{ operation: string, document_content: object, section_id?: string }} */
  let change;

  switch (mode) {
    case "replace_all":
      change = { operation: "replace", document_content };
      break;
    case "append_end":
      change = { operation: "insert_at_end", document_content };
      break;
    case "insert_start":
      change = { operation: "insert_at_start", document_content };
      break;
    case "insert_after":
      if (!section_id) return { ok: false, error: "section_id_required", mode };
      change = { operation: "insert_after", section_id, document_content };
      break;
    case "insert_before":
      if (!section_id) return { ok: false, error: "section_id_required", mode };
      change = { operation: "insert_before", section_id, document_content };
      break;
    case "replace_section":
      if (!section_id) return { ok: false, error: "section_id_required", mode };
      change = { operation: "replace", section_id, document_content };
      break;
    default:
      change = { operation: "insert_at_end", document_content };
  }

  const changes = [change];

  const res = await client.canvases.edit({ canvas_id, changes });
  if (!res.ok) {
    return { ok: false, error: res.error, detail: res.detail || res.response_metadata };
  }
  return {
    ok: true,
    canvas_id,
    slack_operation: change.operation,
    mode,
    section_id: section_id || undefined,
  };
}

/**
 * @param {string} userToken
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ defaultChannelId?: string|null, teamId?: string|null }} [ctx]
 */
async function dispatchCanvasTool(userToken, name, args, ctx = {}) {
  const client = userWebClient(userToken);
  const a = args && typeof args === "object" ? args : {};
  const teamId = ctx.teamId || null;

  try {
    if (name === "slack_canvas_create") {
      const channel_id = a.channel_id || ctx.defaultChannelId || undefined;
      const out = await canvasCreate(client, {
        title: a.title,
        markdown: a.markdown,
        channel_id,
      });
      return enrichCanvasToolResult(out, teamId);
    }
    if (name === "slack_canvas_read") {
      const out = await canvasRead(client, {
        canvas_id: a.canvas_id,
        contains_text: a.contains_text,
      });
      return enrichCanvasToolResult(out, teamId);
    }
    if (name === "slack_canvas_update") {
      const out = await canvasUpdate(client, {
        canvas_id: a.canvas_id,
        markdown: a.markdown,
        mode: a.mode,
        section_id: a.section_id,
      });
      return enrichCanvasToolResult(out, teamId);
    }
    return { ok: false, error: "unknown_tool", name };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  dispatchCanvasTool,
  canvasCreate,
  canvasRead,
  canvasUpdate,
  buildSlackCanvasWebUrl,
};
