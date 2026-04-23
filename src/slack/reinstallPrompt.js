/**
 * Copy for cases where OAuth scopes changed or are missing: steer users to App Home → Re-install
 * (same flow as the Re-install button in `appHome.js`).
 */

function appDisplayName() {
  const fromEnv = (process.env.SLACK_APP_DISPLAY_NAME || "").trim();
  return fromEnv || "Prism";
}

/** Core instruction; Slack mrkdwn (*bold*). */
function reinstallViaAppHomeMrkdwn() {
  const app = appDisplayName();
  return (
    `Open *Apps* → *${app}* → *Home*, then tap *Re-install* at the top. ` +
    "That re-issues OAuth tokens so new bot or user scopes take effect (for example `files:write` for Tableau image uploads)."
  );
}

/**
 * Shown when there is no installation row / user should authorize.
 * @param {string} installUrl from getInstallUrl() or ""
 */
function authorizeMessageWithOptionalInstallUrl(installUrl) {
  const intro =
    "To use channel summaries, canvas, Tableau tools, and related Slack APIs, this workspace needs up-to-date OAuth scopes. ";
  const tail = installUrl
    ? `\n\nYou can also authorize with this link: ${installUrl}`
    : "";
  return `${intro}${reinstallViaAppHomeMrkdwn()}${tail}`;
}

/** Injected into Slack context for the model when channel reads need a user token. */
function modelContextChannelAccessReinstallNote() {
  return (
    "[slack-mcp-agent does not have channel access for this installation (no stored user token). " +
    `Tell the user to open *Apps* → *${appDisplayName()}* → *Home* and tap *Re-install* so they grant user scopes for channel reads.]`
  );
}

/** Extra lines after channel access error bullets (Slack context for the model). */
function channelAccessMissingScopeHintLines() {
  return [
    "If you see `missing_scope`, a workspace admin should add the listed **bot** scopes under Slack *app settings → OAuth & Permissions*, save the app config, then each user who needs the fix should open *Apps* → *" +
      appDisplayName() +
      "* → *Home* and tap *Re-install* so this workspace’s bot token is reissued with those scopes.",
    "For **private** channels, invite the app to the channel (or use a user install with user scopes so reads use that member’s token).",
  ];
}

function slackApiData(err) {
  return err && typeof err === "object" && err.data && typeof err.data === "object" ? err.data : null;
}

function isSlackMissingScopeError(err) {
  const d = slackApiData(err);
  if (d && d.error === "missing_scope") return true;
  return /missing_scope/i.test(String(err?.message || ""));
}

function slackNeededScope(err) {
  const d = slackApiData(err);
  return d && typeof d.needed === "string" ? d.needed : "";
}

/**
 * Short follow-up when files.uploadV2 (etc.) fails for scope reasons.
 * @returns {string|null} Slack mrkdwn or null if not a scope error
 */
function fileUploadReinstallFollowUpMrkdwn(err) {
  if (!isSlackMissingScopeError(err)) return null;
  const needed = slackNeededScope(err);
  const app = appDisplayName();
  const scopePart = needed
    ? `Slack returned *missing_scope* (this call needs \`${needed}\`).`
    : "Slack returned *missing_scope* (a bot OAuth scope is missing).";
  return (
    `:warning: *Couldn’t attach the file(s).* ${scopePart}\n\n` +
    `If a workspace admin already added the scope in *OAuth & Permissions*, open *Apps* → *${app}* → *Home* and tap *Re-install* at the top so this workspace picks up a fresh token.`
  );
}

/**
 * Posts a thread/channel message when uploads fail for missing_scope.
 * @param {object} opts
 * @param {import("@slack/web-api").WebClient} opts.client
 * @param {string} [opts.channelId]
 * @param {string|null|undefined} [opts.threadTs]
 * @param {unknown} opts.err
 * @param {{ warn?: function }} [opts.logger]
 * @param {(msg: { text: string }) => Promise<unknown>} [opts.say] Bolt say (Assistant); else uses chat.postMessage
 */
async function postFileUploadReinstallHintIfNeeded(opts) {
  const { client, channelId, threadTs, err, logger, say } = opts || {};
  const text = fileUploadReinstallFollowUpMrkdwn(err);
  if (!text) return;
  try {
    if (typeof say === "function") await say({ text });
    else if (client && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text,
      });
    }
  } catch (postErr) {
    (logger && logger.warn) || console.warn(
      "[reinstallPrompt] follow-up post failed:",
      postErr?.message || postErr,
    );
  }
}

module.exports = {
  authorizeMessageWithOptionalInstallUrl,
  modelContextChannelAccessReinstallNote,
  channelAccessMissingScopeHintLines,
  postFileUploadReinstallHintIfNeeded,
};
