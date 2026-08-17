const { extractUploadedFiles } = require("../canvas/canvasImages");

/**
 * Upload binary files into a Slack channel (optionally in a thread) using files.uploadV2.
 * Requires the bot OAuth scope `files:write`.
 *
 * @param {import("@slack/web-api").WebClient} client
 * @param {{ channelId: string, threadTs?: string | null, uploads: Array<{ buffer: Buffer, filename: string, title?: string }> }} opts
 * @returns {Promise<Array<{ id: string, permalink: string, title?: string }>>} uploaded file refs (id + permalink), for canvas embedding
 */
async function postThreadFileUploads(client, opts) {
  const { channelId, threadTs, uploads } = opts || {};
  if (!client || !channelId || !uploads?.length) return [];

  const payload = {
    channel_id: channelId,
    file_uploads: uploads.map((u) => ({
      file: u.buffer,
      filename: u.filename,
      title: u.title || u.filename,
    })),
  };
  if (threadTs) payload.thread_ts = threadTs;

  const res = await client.files.uploadV2(payload);
  return extractUploadedFiles(res);
}

module.exports = { postThreadFileUploads };
