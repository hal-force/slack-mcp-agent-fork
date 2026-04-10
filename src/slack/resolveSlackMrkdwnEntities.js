/**
 * Enrich Slack mrkdwn placeholders so workflow outputs read well when the next step posts
 * plain text or when clients show raw `<#C…>` / `<@U…>`.
 *
 * - `<#C123>` → `<#C123|channel-name>` (Slack renders the name in mrkdwn-capable surfaces)
 * - `<@U123>` → optional plain display name when `plainUserNames` (workflow plain-text friendly)
 */

const RE_CHANNEL = /<#(C[A-Z0-9]+)(\|[^>\n]*)?>/gi;
const RE_USER = /<@(U[A-Z0-9]+)(\|[^>\n]*)?>/gi;

/**
 * @param {import("@slack/web-api").WebClient} client
 * @param {string} text
 * @param {{ plainUserNames?: boolean, logger?: { debug?: Function } }} [opts]
 * @returns {Promise<string>}
 */
async function resolveSlackMrkdwnEntities(client, text, opts = {}) {
  const raw = String(text || "");
  if (!raw || !client) return raw;

  const { plainUserNames = false, logger } = opts;

  const channelIdsNeedingLabel = new Set();
  let m;
  RE_CHANNEL.lastIndex = 0;
  while ((m = RE_CHANNEL.exec(raw)) !== null) {
    const id = m[1].toUpperCase();
    const hasLabel = m[2] && m[2].length > 1;
    if (!hasLabel) channelIdsNeedingLabel.add(id);
  }

  const userIdsNeedingResolve = new Set();
  RE_USER.lastIndex = 0;
  while ((m = RE_USER.exec(raw)) !== null) {
    const id = m[1].toUpperCase();
    const hasLabel = m[2] && m[2].length > 1;
    if (plainUserNames && !hasLabel) userIdsNeedingResolve.add(id);
  }

  const channelLabelById = new Map();
  for (const cid of channelIdsNeedingLabel) {
    try {
      const res = await client.conversations.info({ channel: cid });
      const name = res.channel?.name;
      if (name && typeof name === "string") {
        channelLabelById.set(cid, name.replace(/[>|]/g, "").trim() || cid);
      }
    } catch (err) {
      logger?.debug?.(`resolveSlackMrkdwnEntities conversations.info ${cid}: ${err.message}`);
    }
  }

  const userPlainById = new Map();
  for (const uid of userIdsNeedingResolve) {
    try {
      const res = await client.users.info({ user: uid });
      const u = res.user;
      const label =
        (u?.profile?.display_name && String(u.profile.display_name).trim()) ||
        (u?.profile?.real_name && String(u.profile.real_name).trim()) ||
        (u?.name && String(u.name).trim()) ||
        uid;
      userPlainById.set(uid, String(label).replace(/[>|]/g, "").trim() || uid);
    } catch (err) {
      logger?.debug?.(`resolveSlackMrkdwnEntities users.info ${uid}: ${err.message}`);
    }
  }

  let out = raw;
  for (const [cid, label] of channelLabelById) {
    out = out.replace(new RegExp(`<#${cid}>`, "gi"), `<#${cid}|${label}>`);
  }
  for (const [uid, label] of userPlainById) {
    out = out.replace(new RegExp(`<@${uid}>`, "gi"), label);
  }

  return out;
}

module.exports = { resolveSlackMrkdwnEntities };
