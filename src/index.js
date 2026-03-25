require("dotenv").config();

// Heroku: if GCP_SERVICE_ACCOUNT_JSON is set (JSON string), write to temp file for Vertex AI
if (process.env.GCP_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const fs = require("fs");
  const path = require("path");
  const tmp = path.join(process.env.TMPDIR || "/tmp", "gcp-sa-" + Date.now() + ".json");
  fs.writeFileSync(tmp, process.env.GCP_SERVICE_ACCOUNT_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
}

const { App, Assistant } = require("@slack/bolt");
const { receiver } = require("./slack/receiver");
const { getAiResponse } = require("./assistant/respond");
const { buildSlackContext } = require("./assistant/slackContext");
const { buildTableauContext } = require("./assistant/tableauMcpClient");
const { getInstallation } = require("./install-kit/installationStore");
const { getInstallUrl } = require("./install-kit/env");

/** Shown when the workspace has no matching installation in our store; includes install link if PUBLIC_BASE_URL is set. */
function getAuthorizeMessage() {
  const url = getInstallUrl();
  return url
    ? "To use channel summaries and full features, authorize slack-mcp-agent: " + url
    : "To use channel summaries and full features, authorize slack-mcp-agent from Apps → slack-mcp-agent → Configuration.";
}

const app = new App({
  receiver,
});

// ----- @mentions (channel / thread) -----
app.event("app_mention", async ({ event, body, client, logger }) => {
  try {
    const userMessage = event.text?.replace(/<@[A-Z0-9]+>/g, "").trim() || "";
    const installation = await getInstallation({
      teamId: body?.team_id || body?.authorizations?.[0]?.team_id || event?.team,
      enterpriseId: body?.enterprise_id || body?.authorizations?.[0]?.enterprise_id || event?.enterprise_id,
      isEnterpriseInstall: !!body?.is_enterprise_install || !!body?.authorizations?.[0]?.is_enterprise_install,
      userId: body?.user_id || event?.user || body?.authorizations?.[0]?.user_id,
    });
    const slackContext = await buildSlackContext(client, {
      userToken: installation?.user?.token,
      channelId: event.channel,
      threadTs: event.thread_ts || event.ts,
      userMessage,
    });
    const tableauContext = await buildTableauContext(userMessage);
    const contextForAi = [slackContext, tableauContext].filter(Boolean).join("\n");
    const teamId =
      body?.team_id || body?.authorizations?.[0]?.team_id || event?.team || event?.team_id || null;
    const response = await getAiResponse({
      userMessage,
      slackContext: contextForAi || undefined,
      userToken: installation?.user?.token,
      defaultCanvasChannelId: event.channel,
      teamId,
    });
    const threadTs = event.thread_ts || event.ts;
    const replyText =
      installation ? response : `${response}\n\n---\n${getAuthorizeMessage()}`;

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: replyText,
    });
  } catch (err) {
    logger.error("app_mention handler error", err);
  }
});

// ----- Assistant thread (side panel / DM) -----
const assistant = new Assistant({
  threadStarted: async ({ say, saveThreadContext, setSuggestedPrompts, body, context }) => {
    await say("Hey! I'm Prism. I can search your Slack workspace, pull in context from recent conversations, and connect to Tableau data to help you get real answers — fast. What's on your mind?");
    const installQuery = {
      teamId: body?.team_id || body?.authorizations?.[0]?.team_id || context?.teamId || context?.team?.id,
      enterpriseId: body?.enterprise_id || body?.authorizations?.[0]?.enterprise_id || context?.enterpriseId || context?.enterprise?.id,
      isEnterpriseInstall: !!body?.is_enterprise_install || !!body?.authorizations?.[0]?.is_enterprise_install || !!context?.isEnterpriseInstall,
      userId: body?.user_id || body?.authorizations?.[0]?.user_id || context?.userId,
    };
    const installation = await getInstallation(installQuery);
    if (!installation) {
      await say(getAuthorizeMessage());
    }
    await saveThreadContext();
    await setSuggestedPrompts({
      title: "Try these:",
      prompts: [
        { title: "Summarize", message: "Summarize the key points from this channel." },
        { title: "Ask anything", message: "What can you help me with?" },
      ],
    });
  },

  threadContextChanged: async ({ saveThreadContext }) => {
    await saveThreadContext();
  },

  userMessage: async ({ body, client, context, message, getThreadContext, say, setStatus, setTitle, logger }) => {
    if (!("text" in message) || !message.text?.trim() || !("thread_ts" in message)) return;

    const { channel, thread_ts } = message;
    const text = message.text.trim();
    const installQuery = {
      teamId: body?.team_id || body?.authorizations?.[0]?.team_id || context?.teamId || context?.team?.id,
      enterpriseId: body?.enterprise_id || body?.authorizations?.[0]?.enterprise_id || context?.enterpriseId || context?.enterprise?.id,
      isEnterpriseInstall: !!body?.is_enterprise_install || !!body?.authorizations?.[0]?.is_enterprise_install || !!context?.isEnterpriseInstall,
      userId: body?.user_id || body?.event?.user || body?.authorizations?.[0]?.user_id || context?.userId || message?.user,
    };
    const installation = await getInstallation(installQuery);

    const hasChannelRefs = /#([a-z0-9][a-z0-9._-]*)/i.test(text) || /\b(this|the) channel\b/i.test(text);
    if (hasChannelRefs && process.env.SLACK_CONTEXT_DEBUG === "1") {
      console.log("[slack-mcp-agent] installQuery:", JSON.stringify(installQuery), "found:", !!installation, "userToken:", !!installation?.user?.token);
    }

    try {
      await setTitle(text.slice(0, 80));
      await setStatus({
        status: "Thinking…",
        loading_messages: ["Reading your message…", "Getting ready to respond…"],
      });

      let threadHistory = [];
      try {
        const replies = await client.conversations.replies({
          channel,
          ts: thread_ts,
          oldest: thread_ts,
        });
        threadHistory = (replies.messages || []).map((m) => ({
          role: m.bot_id ? "assistant" : "user",
          text: m.text || "",
        }));
      } catch (_) {
        // no thread history
      }

      // Thread context includes channel_id when user opened Assistant from a channel (e.g. "this channel")
      const threadContext = await getThreadContext?.();
      const contextChannelId = threadContext?.channel_id || null;

      const userToken = installation?.user?.token;
      const needsUserToken = hasChannelRefs && !userToken;

      if (needsUserToken && process.env.SLACK_CONTEXT_DEBUG === "1") {
        console.log("[slack-mcp-agent] No user token for channel access. Reinstall may be needed.");
      }

      let slackContext = await buildSlackContext(client, {
        userToken,
        channelId: channel,
        threadTs: thread_ts,
        userMessage: text,
        skipChannelAndThread: true, // we already have threadHistory
        includeSearch: true,
        contextChannelId, // channel user is viewing when they say "summarize this channel"
        teamId: body?.team_id || context?.teamId || context?.team?.id,
      });

      if (needsUserToken) {
        const reinstallNote =
          "[slack-mcp-agent does not have channel access for this installation. To summarize channels, the user must reinstall slack-mcp-agent from Slack app settings (Apps → slack-mcp-agent → Configuration) so the app can request channel permissions.]";
        slackContext = slackContext
          ? `${reinstallNote}\n\n${slackContext}`
          : `\n--- Slack context ---\n${reinstallNote}\n--- End Slack context ---\n`;
      }

      const threadHint = threadHistory.map((m) => m.text || "").join("\n");
      const tableauContext = await buildTableauContext(text, { threadHint });

      const contextForAi = [slackContext, tableauContext].filter(Boolean).join("\n");

      const teamId =
        body?.team_id ||
        body?.authorizations?.[0]?.team_id ||
        context?.teamId ||
        context?.team?.id ||
        null;
      const response = await getAiResponse({
        userMessage: text,
        threadHistory,
        slackContext: contextForAi || undefined,
        userToken: installation?.user?.token,
        defaultCanvasChannelId: contextChannelId || channel,
        teamId,
      });

      const replyText =
        installation ? response : `${response}\n\n---\n${getAuthorizeMessage()}`;
      await say({ text: replyText });
    } catch (err) {
      logger.error("Assistant userMessage error", err);
      await say({ text: "Something went wrong. Please try again." });
    }
  },
});

app.assistant(assistant);

// ----- Start -----
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ slack-mcp-agent listening on :${port}`);
})();
