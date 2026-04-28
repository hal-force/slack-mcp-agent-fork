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
const { getTableauMcpUrlOverride } = require("./preferences/userPreferences");
const { registerAppHome } = require("./slack/appHome");
const { registerAskAiWorkflowStep } = require("./slack/workflowAskAi");
const { getUserLocaleContext } = require("./assistant/userLocale");
const { mrkdwnStringToBlocks } = require("./slack/mrkdwnToBlocks");
const { postThreadFileUploads } = require("./slack/postThreadFileUploads");
const {
  authorizeMessageWithOptionalInstallUrl,
  modelContextChannelAccessReinstallNote,
  postFileUploadReinstallHintIfNeeded,
} = require("./slack/reinstallPrompt");

/** Shown when the workspace has no matching installation in our store; includes install link if PUBLIC_BASE_URL is set. */
function getAuthorizeMessage() {
  return authorizeMessageWithOptionalInstallUrl(getInstallUrl());
}

const app = new App({
  receiver,
});

// function_executed: Bolt skips the immediate Events API ack and relies on app.function's autoAcknowledge,
// which runs after other global middleware. That can exceed Slack's HTTP ack window while Vertex runs.
// Ack here first, then disable duplicate ack on the Ask AI step (see workflowAskAi.js).
app.use(async ({ body, next, ack }) => {
  if (body?.event?.type === "function_executed" && typeof ack === "function") {
    await ack();
  }
  await next();
});

registerAppHome(app);
registerAskAiWorkflowStep(app, { getAiResponse });

// ----- @mentions (channel / thread) -----
app.event("app_mention", async ({ event, body, client, logger }) => {
  try {
    const userMessage = event.text?.replace(/<@[A-Z0-9]+>/g, "").trim() || "";
    const installQuery = {
      teamId: body?.team_id || body?.authorizations?.[0]?.team_id || event?.team,
      enterpriseId: body?.enterprise_id || body?.authorizations?.[0]?.enterprise_id || event?.enterprise_id,
      isEnterpriseInstall: !!body?.is_enterprise_install || !!body?.authorizations?.[0]?.is_enterprise_install,
      userId: body?.user_id || event?.user || body?.authorizations?.[0]?.user_id,
    };
    const [installation, tableauMcpBaseUrl] = await Promise.all([
      getInstallation(installQuery),
      getTableauMcpUrlOverride(installQuery),
    ]);
    const [slackContext, tableauBlock, localeContext] = await Promise.all([
      buildSlackContext(client, {
        userToken: installation?.user?.token,
        channelId: event.channel,
        threadTs: event.thread_ts || event.ts,
        userMessage,
      }),
      buildTableauContext(userMessage, { tableauMcpBaseUrl }),
      getUserLocaleContext(client, installQuery.userId),
    ]);
    const tableauContext = tableauBlock.context;
    const contextForAi = [localeContext, slackContext, tableauContext].filter(Boolean).join("\n");
    const teamId =
      body?.team_id || body?.authorizations?.[0]?.team_id || event?.team || event?.team_id || null;
    const response = await getAiResponse({
      userMessage,
      slackContext: contextForAi || undefined,
      userToken: installation?.user?.token,
      defaultCanvasChannelId: event.channel,
      teamId,
      tableauMcpBaseUrl,
      datasourceUrls: tableauBlock.datasourceUrls,
    });
    const threadTs = event.thread_ts || event.ts;
    const replyText =
      installation ? response.text : `${response.text}\n\n---\n${getAuthorizeMessage()}`;

    const { text: notifyText, blocks } = mrkdwnStringToBlocks(replyText);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: notifyText,
      blocks,
    });
    if (response.uploads?.length) {
      try {
        await postThreadFileUploads(client, {
          channelId: event.channel,
          threadTs,
          uploads: response.uploads,
        });
      } catch (uploadErr) {
        logger.error("app_mention Tableau file upload error", uploadErr);
        await postFileUploadReinstallHintIfNeeded({
          client,
          channelId: event.channel,
          threadTs,
          err: uploadErr,
          logger,
        });
      }
    }
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
    const [installation, tableauMcpBaseUrl] = await Promise.all([
      getInstallation(installQuery),
      getTableauMcpUrlOverride(installQuery),
    ]);

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

      // Thread context includes channel_id when user opened Assistant from a channel (e.g. "this channel")
      const threadContext = await getThreadContext?.();
      const contextChannelId = threadContext?.channel_id || null;

      const userToken = installation?.user?.token;
      const needsUserToken = hasChannelRefs && !userToken;

      if (needsUserToken && process.env.SLACK_CONTEXT_DEBUG === "1") {
        console.log("[slack-mcp-agent] No user token for channel access. Reinstall may be needed.");
      }

      const teamIdForContext = body?.team_id || context?.teamId || context?.team?.id;

      // Fetch thread history and slack context concurrently — buildSlackContext uses
      // skipChannelAndThread so it doesn't depend on the replies result.
      const [repliesRes, slackContextResult, localeContext] = await Promise.all([
        client.conversations.replies({ channel, ts: thread_ts, oldest: thread_ts }).catch(() => ({ messages: [] })),
        buildSlackContext(client, {
          userToken,
          channelId: channel,
          threadTs: thread_ts,
          userMessage: text,
          skipChannelAndThread: true,
          includeSearch: true,
          contextChannelId,
          teamId: teamIdForContext,
        }),
        getUserLocaleContext(client, installQuery.userId),
      ]);

      let threadHistory = (repliesRes.messages || []).map((m) => ({
        role: m.bot_id ? "assistant" : "user",
        text: m.text || "",
      }));

      let slackContext = slackContextResult;

      // threadHint lets buildTableauContext match datasource names from prior thread messages
      // to LUIDs for metadata pre-fetch — must come after replies are resolved.
      const threadHint = threadHistory.map((m) => m.text || "").join("\n");
      const tableauBlock = await buildTableauContext(text, { threadHint, tableauMcpBaseUrl });
      const tableauContext = tableauBlock.context;

      const contextForAi = [localeContext, slackContext, tableauContext].filter(Boolean).join("\n");

      const teamId =
        body?.team_id ||
        body?.authorizations?.[0]?.team_id ||
        teamIdForContext ||
        null;
      const response = await getAiResponse({
        userMessage: text,
        threadHistory,
        slackContext: contextForAi || undefined,
        userToken: installation?.user?.token,
        defaultCanvasChannelId: contextChannelId || channel,
        teamId,
        tableauMcpBaseUrl,
        datasourceUrls: tableauBlock.datasourceUrls,
      });

      const replyText =
        installation ? response.text : `${response.text}\n\n---\n${getAuthorizeMessage()}`;
      const { text: notifyText, blocks } = mrkdwnStringToBlocks(replyText);
      await say({ text: notifyText, blocks });
      if (response.uploads?.length) {
        try {
          await postThreadFileUploads(client, {
            channelId: channel,
            threadTs: thread_ts,
            uploads: response.uploads,
          });
        } catch (uploadErr) {
          logger.error("Assistant Tableau file upload error", uploadErr);
          await postFileUploadReinstallHintIfNeeded({
            client,
            channelId: channel,
            threadTs: thread_ts,
            err: uploadErr,
            logger,
            say,
          });
        }
      }
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
