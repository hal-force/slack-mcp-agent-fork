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
const { getInstallation } = require("./install-kit/installationStore");
const { getInstallUrl } = require("./install-kit/env");
const { getTableauMcpUrlOverride, getInternetSearchEnabled } = require("./preferences/userPreferences");
const { resolveTableauMcpUrl } = require("./assistant/tableauMcpClient");
const { registerAppHome } = require("./slack/appHome");
const { registerAskAiWorkflowStep } = require("./slack/workflowAskAi");
const { getUserLocaleContext } = require("./assistant/userLocale");
const { classifyIntent } = require("./router/intentRouter");
const { resolveActiveSkills, executeActiveSkills } = require("./skills/registry");
const { installQueryFromBoltContext } = require("./install-kit/installQuery");
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
    const installQuery = installQueryFromBoltContext(body, {}, event);
    const [installation, tableauMcpUrlOverride, useInternetSearch] = await Promise.all([
      getInstallation(installQuery),
      getTableauMcpUrlOverride(installQuery),
      getInternetSearchEnabled(installQuery),
    ]);
    // Effective URL = per-user override, else the host default (TABLEAU_MCP_SERVER).
    // Gating (tableauEnabled) must use this, not the raw override, or a deployment-wide
    // default never enables the skill.
    const tableauMcpBaseUrl = resolveTableauMcpUrl(tableauMcpUrlOverride);
    if (process.env.SLACK_CONTEXT_DEBUG === "1") {
      console.log(`[slack-mcp-agent] app_mention useInternetSearch=${useInternetSearch} userId=${installQuery.userId ?? "(none)"}`);
    }
    const teamId =
      body?.team_id || body?.authorizations?.[0]?.team_id || event?.team || event?.team_id || null;
    const userToken = installation?.user?.token;

    // If the mention is inside a thread, pull prior turns so a keyword-less
    // follow-up ("what about last quarter?") stays routed to Tableau.
    let mentionThreadHint = "";
    if (event.thread_ts) {
      const priorReplies = await client.conversations
        .replies({ channel: event.channel, ts: event.thread_ts, oldest: event.thread_ts })
        .catch(() => ({ messages: [] }));
      mentionThreadHint = (priorReplies.messages || []).map((m) => m.text || "").join("\n");
    }

    const { useFullModel, intents } = classifyIntent(
      userMessage,
      {
        tableauEnabled: !!tableauMcpBaseUrl,
        hasUserToken: !!userToken,
        internetSearch: useInternetSearch,
      },
      mentionThreadHint,
    );
    const activeSkills = resolveActiveSkills({
      userToken,
      defaultChannelId: event.channel,
      teamId,
      tableauMcpBaseUrl,
      internetSearchEnabled: useInternetSearch,
    });
    const [localeContext, skillResult] = await Promise.all([
      getUserLocaleContext(client, installQuery.userId),
      executeActiveSkills(activeSkills, intents, {
        userMessage,
        client,
        sessionOpts: {
          userToken,
          channelId: event.channel,
          threadTs: event.thread_ts || event.ts,
          userMessage,
          tableauMcpBaseUrl,
          threadHint: mentionThreadHint,
          defaultChannelId: event.channel,
          teamId,
        },
      }),
    ]);
    const skillContext = [localeContext, ...skillResult.contextParts].filter(Boolean).join("\n");
    const response = await getAiResponse({
      userMessage,
      skillContext: skillContext || undefined,
      uploads: skillResult.uploads,
      sideEffects: skillResult.sideEffects,
      googleSearchActive: skillResult.googleSearchActive,
      systemPromptSections: skillResult.systemPromptSections,
      userToken,
      defaultCanvasChannelId: event.channel,
      teamId,
      useFullModel,
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
    const installQuery = installQueryFromBoltContext(body, context);
    const installation = await getInstallation(installQuery);
    if (!installation) {
      await say(getAuthorizeMessage());
    }
    await saveThreadContext();

    // Build dynamic suggested prompts from the user's recent channels when possible.
    let suggestedPrompts = [
      { title: "Summarize", message: "Summarize the key points from this channel." },
      { title: "Ask anything", message: "What can you help me with?" },
    ];
    try {
      const userToken = installation?.user?.token;
      const apiClientForSuggestions = userToken ? require("@slack/web-api").WebClient : null;
      const suggestClient = apiClientForSuggestions ? new apiClientForSuggestions(userToken) : null;
      if (suggestClient) {
        const res = await suggestClient.users.conversations({
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 10,
        });
        const channels = (res.channels || []).filter((c) => c.name);
        if (channels.length >= 2) {
          const picks = channels.slice(0, 3);
          suggestedPrompts = picks.map((ch) => ({
            title: `#${ch.name}`,
            message: `Summarize what's been happening in <#${ch.id}|${ch.name}>.`,
          }));
          suggestedPrompts.push({ title: "Ask anything", message: "What can you help me with?" });
        }
      }
    } catch (_) {
      // Fall back to static prompts if channel fetch fails.
    }
    await setSuggestedPrompts({ title: "Try these:", prompts: suggestedPrompts });
  },

  threadContextChanged: async ({ saveThreadContext }) => {
    await saveThreadContext();
  },

  userMessage: async ({ body, client, context, message, getThreadContext, say, setStatus, setTitle, logger }) => {
    if (!("text" in message) || !message.text?.trim() || !("thread_ts" in message)) return;

    const { channel, thread_ts } = message;
    const text = message.text.trim();
    const installQuery = installQueryFromBoltContext(body, context, { user: message?.user });
    const [installation, tableauMcpUrlOverride, useInternetSearch] = await Promise.all([
      getInstallation(installQuery),
      getTableauMcpUrlOverride(installQuery),
      getInternetSearchEnabled(installQuery),
    ]);
    // Effective URL = per-user override, else the host default (TABLEAU_MCP_SERVER).
    const tableauMcpBaseUrl = resolveTableauMcpUrl(tableauMcpUrlOverride);
    if (process.env.SLACK_CONTEXT_DEBUG === "1") {
      console.log(`[slack-mcp-agent] assistant useInternetSearch=${useInternetSearch} userId=${installQuery.userId ?? "(none)"}`);
    }

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
      const teamId = body?.team_id || body?.authorizations?.[0]?.team_id || teamIdForContext || null;

      // Fetch thread history first: threadHint feeds both Tableau datasource
      // matching AND intent classification (so a keyword-less follow-up in a
      // Tableau thread stays routed to Tableau).
      const repliesRes = await client.conversations
        .replies({ channel, ts: thread_ts, oldest: thread_ts })
        .catch(() => ({ messages: [] }));

      const threadHistory = (repliesRes.messages || []).map((m) => ({
        role: m.bot_id ? "assistant" : "user",
        text: m.text || "",
      }));
      const threadHint = threadHistory.map((m) => m.text || "").join("\n");

      const { useFullModel, intents } = classifyIntent(
        text,
        {
          tableauEnabled: !!tableauMcpBaseUrl,
          hasUserToken: !!userToken,
          internetSearch: useInternetSearch,
        },
        threadHint,
      );

      const activeSkills = resolveActiveSkills({
        userToken,
        defaultChannelId: contextChannelId || channel,
        teamId,
        tableauMcpBaseUrl,
        internetSearchEnabled: useInternetSearch,
      });

      const [localeContext, skillResult] = await Promise.all([
        getUserLocaleContext(client, installQuery.userId),
        executeActiveSkills(activeSkills, intents, {
          userMessage: text,
          threadHistory,
          client,
          sessionOpts: {
            userToken,
            channelId: channel,
            threadTs: thread_ts,
            userMessage: text,
            skipChannelAndThread: true,
            includeSearch: true,
            contextChannelId,
            teamId,
            tableauMcpBaseUrl,
            threadHint,
            defaultChannelId: contextChannelId || channel,
          },
        }),
      ]);

      const skillContext = [localeContext, ...skillResult.contextParts].filter(Boolean).join("\n");
      const response = await getAiResponse({
        userMessage: text,
        threadHistory,
        skillContext: skillContext || undefined,
        uploads: skillResult.uploads,
        sideEffects: skillResult.sideEffects,
        googleSearchActive: skillResult.googleSearchActive,
        systemPromptSections: skillResult.systemPromptSections,
        userToken,
        defaultCanvasChannelId: contextChannelId || channel,
        teamId,
        useFullModel,
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
