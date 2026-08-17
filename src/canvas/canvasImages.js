/**
 * Embed images (e.g. rendered Tableau view PNGs) into a Slack canvas.
 *
 * Slack canvases don't take raw image bytes or ![](url) markdown. They render
 * images via **file unfurls**: you upload the file (needs the bot `files:write`
 * scope — the installing user's xoxp token does NOT have it), then place the
 * file's Slack permalink in the canvas markdown, and Slack unfurls it inline.
 *
 * So the flow is: bot files.uploadV2 (once, sharing to the reply channel/thread
 * so the file is accessible to canvas viewers) → collect permalinks →
 * buildCanvasImageSection() → append to the canvas markdown before canvases.edit.
 */

/**
 * Normalize the files.uploadV2 response into flat {id, permalink, title} refs.
 * uploadV2 nests results as { files: [ { files: [ {id, permalink, …} ] } ] }
 * in some SDK versions and { files: [ {id, permalink} ] } in others, so walk
 * the structure and collect every node that has both an id and a permalink.
 *
 * @param {unknown} res - files.uploadV2 response
 * @returns {Array<{ id: string, permalink: string, title?: string }>}
 */
function extractUploadedFiles(res) {
  const out = [];
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      const id = node.id;
      const permalink = node.permalink || node.permalink_public;
      if (typeof id === "string" && typeof permalink === "string" && !seen.has(id)) {
        seen.add(id);
        out.push({ id, permalink, title: node.title || node.name || undefined });
      }
      if (Array.isArray(node.files)) visit(node.files, depth + 1);
    }
  };
  visit(res && (res.files || res.file), 0);
  return out;
}

/**
 * Upload image buffers via the BOT client (files:write) so each gets a Slack
 * permalink usable as a canvas file-unfurl. Sharing to channelId/threadTs also
 * posts them in the reply thread, so the same upload serves both surfaces (no
 * double upload) and makes the file accessible to people viewing the canvas.
 *
 * @param {import('@slack/web-api').WebClient} botClient
 * @param {Array<{ buffer: Buffer, filename: string, title?: string }>} uploads
 * @param {{ channelId?: string|null, threadTs?: string|null }} [opts]
 * @returns {Promise<Array<{ id: string, permalink: string, title?: string }>>}
 */
async function uploadImagesForCanvas(botClient, uploads, opts = {}) {
  if (!botClient || !Array.isArray(uploads) || uploads.length === 0) return [];
  const payload = {
    file_uploads: uploads.map((u) => ({
      file: u.buffer,
      filename: u.filename,
      title: u.title || u.filename,
    })),
  };
  if (opts.channelId) payload.channel_id = opts.channelId;
  if (opts.threadTs) payload.thread_ts = opts.threadTs;
  const res = await botClient.files.uploadV2(payload);
  return extractUploadedFiles(res);
}

/**
 * Build a canvas markdown section that embeds the given image files.
 *
 * Canvas-flavored markdown renders an uploaded Slack file (a `*.slack.com/files/*`
 * permalink) inline ONLY via the markdown-image form `![alt](permalink)` placed on
 * its own line — a bare permalink URL renders as a plain link, not an image. Each
 * image gets an optional bold caption line above it.
 *
 * @param {Array<{ permalink: string, title?: string }>} imageRefs
 * @param {{ heading?: string }} [opts]
 * @returns {string} markdown to append to the canvas body (empty if no refs)
 */
function buildCanvasImageSection(imageRefs, opts = {}) {
  const refs = (Array.isArray(imageRefs) ? imageRefs : []).filter((r) => r && r.permalink);
  if (refs.length === 0) return "";
  const heading = opts.heading || "Visualizations";
  const blocks = refs.map((r) => {
    const alt = r.title ? String(r.title).replace(/[[\]]/g, "").trim() : "";
    const caption = alt ? `**${alt.replace(/\*/g, "")}**\n` : "";
    // `![alt](permalink)` on its own line is what canvas markdown renders as an
    // inline image card; a bare permalink would only show as a link.
    return `${caption}![${alt}](${r.permalink})`;
  });
  return `\n\n---\n\n## ${heading}\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Append an image section (file-unfurl links) to each canvas written this turn.
 * Called by a message handler AFTER it has uploaded the images with the bot
 * client and captured their permalinks. Uses the installing user's xoxp token
 * (canvases:write) to edit the canvas. Best-effort: logs and continues on error
 * so a canvas-embed failure never breaks the main reply.
 *
 * @param {object} p
 * @param {string} p.userToken - xoxp token with canvases:write
 * @param {Array<{ canvas_id: string }>} p.canvasUpdates - canvases written this turn
 * @param {Array<{ permalink: string, title?: string }>} p.imageRefs - uploaded image files
 * @param {string|null} [p.teamId]
 * @param {string|null} [p.defaultChannelId]
 * @param {{ heading?: string }} [p.opts]
 * @param {(name: string, args: object, ctx: object) => Promise<object>} [dispatch] - injectable for tests
 * @returns {Promise<number>} number of canvases successfully appended to
 */
async function embedImagesInCanvases(
  { userToken, canvasUpdates, imageRefs, teamId = null, defaultChannelId = null, opts = {} },
  dispatch,
) {
  if (!userToken) return 0;
  const updates = (Array.isArray(canvasUpdates) ? canvasUpdates : []).filter(
    (c) => c && c.canvas_id,
  );
  const section = buildCanvasImageSection(imageRefs, opts);
  if (updates.length === 0 || !section) return 0;

  const dispatchCanvasTool =
    dispatch || require("./userCanvasActions").dispatchCanvasTool;

  let ok = 0;
  for (const cu of updates) {
    try {
      const res = await dispatchCanvasTool(
        userToken,
        "slack_canvas_update",
        { canvas_id: cu.canvas_id, markdown: section, mode: "append_end" },
        { defaultChannelId, teamId },
      );
      if (res && res.ok !== false) ok += 1;
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.error("[embedImagesInCanvases] error:", err?.message || err);
      }
    }
  }
  return ok;
}

module.exports = {
  extractUploadedFiles,
  uploadImagesForCanvas,
  buildCanvasImageSection,
  embedImagesInCanvases,
};
