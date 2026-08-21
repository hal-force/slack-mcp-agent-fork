require("dotenv").config();

// Heroku: if GCP_SERVICE_ACCOUNT_JSON is set (JSON string), write to temp file for Vertex AI.
// Write it 0600 (owner read/write only) inside a private per-process temp dir
// (mkdtempSync → unpredictable name, 0700) so the service-account credential is
// neither world-readable nor at a guessable path, and unlink it on exit.
if (process.env.GCP_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "gcp-sa-"));
  const tmp = path.join(dir, "key.json");
  fs.writeFileSync(tmp, process.env.GCP_SERVICE_ACCOUNT_JSON, { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  };
  process.once("exit", cleanup);
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
}

const { App, Assistant } = require("@slack/bolt");
const { receiver } = require("./slack/receiver");
const { registerTableauWebhook } = require("./jobs/tableauWebhook");
const { registerDailyBriefTrigger } = require("./jobs/dailyBriefTrigger");
const { registerTriageAdmissionTrigger } = require("./jobs/triageAdmissionTrigger");
const { getAiResponse } = require("./assistant/respond");
const { runSupervised } = require("./agents/supervisor");
const { createTriageSpecialist } = require("./agents/triageSpecialist");
const { composeTriageReply } = require("./agents/composeTriageReply");

// Multi-agent deps injected into runSupervised. When AGENTS_ENABLED is off
// (default), the supervisor ignores these and delegates to getAiResponse — so
// constructing the specialist here has no effect on the baseline path. Built
// once at module load; the specialist itself holds no per-request state.
const triageSpecialist = createTriageSpecialist();
const supervisorDeps = { getAiResponse, triageSpecialist, composeTriageReply };
const { getInstallation } = require("./install-kit/installationStore");
const { getInstallUrl } = require("./install-kit/env");
const { getUserPreferences } = require("./preferences/userPreferences");
const { resolveTableauMcpUrl } = require("./assistant/tableauMcpClient");
const { registerAppHome } = require("./slack/appHome");
const { registerAskAiWorkflowStep } = require("./slack/workflowAskAi");
const { getUserLocaleContext } = require("./assistant/userLocale");
const { classifyIntent } = require("./router/intentRouter");
const { resolveActiveSkills, executeActiveSkills } = require("./skills/registry");
const { installQueryFromBoltContext } = require("./install-kit/installQuery");
const { mrkdwnStringToBlocks } = require("./slack/mrkdwnToBlocks");
const { postThreadFileUploads } = require("./slack/postThreadFileUploads");
const { embedImagesInCanvases } = require("./canvas/canvasImages");
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

// Tableau datasource-refresh webhook → push-triggered localized briefs.
// Mounts a JSON route on the same Express receiver (separate path from Slack's
// events endpoint, so it doesn't touch Slack signature verification). No-ops
// unless TABLEAU_WEBHOOK_SECRET is set. See src/jobs/tableauWebhook.js.
registerTableauWebhook(receiver);

// Scheduled daily-brief HTTP trigger → EventBridge Scheduler (AWS) POSTs here
// once a day, standing in for Heroku Scheduler's `vhaDailyBrief.js --daily`.
// No-ops unless VHA_DAILY_JOB_SECRET is set. See src/jobs/dailyBriefTrigger.js.
registerDailyBriefTrigger(receiver);

// Admission → #nurse-triage HTTP trigger. An admission event POSTs here; the
// multi-agent layer announces the patient and posts a ranked nurse recommendation.
// No-ops unless TRIAGE_ADMISSION_SECRET is set, and refuses to post unless
// AGENTS_ENABLED=1. Resolves the workspace bot token itself (OAuth install store),
// so it doesn't need the Bolt app. See src/jobs/triageAdmissionTrigger.js.
registerTriageAdmissionTrigger(receiver);

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
    const [installation, prefs] = await Promise.all([
      getInstallation(installQuery),
      getUserPreferences(installQuery),
    ]);
    const useInternetSearch = prefs.internetSearch;
    // Effective URL = per-user override, else the host default (TABLEAU_MCP_SERVER).
    // Gating (tableauEnabled) must use this, not the raw override, or a deployment-wide
    // default never enables the skill.
    const tableauMcpBaseUrl = resolveTableauMcpUrl(prefs.tableauMcpUrl);
    if (process.env.SLACK_CONTEXT_DEBUG === "1") {
      console.log(`[slack-mcp-agent] app_mention useInternetSearch=${useInternetSearch} userId=${installQuery.userId ?? "(none)"}`);
    }
    const teamId =
      body?.team_id || body?.authorizations?.[0]?.team_id || event?.team || event?.team_id || null;
    const userToken = installation?.user?.token;

    // If the mention is inside a thread, pull prior turns ONCE so a keyword-less
    // follow-up ("what about last quarter?") stays routed to Tableau. Reuse the
    // same fetch as conversation history for the model and set skipChannelAndThread
    // so the Slack skill doesn't fetch the identical thread again (E6).
    let mentionThreadHint = "";
    let threadHistory = [];
    const inThread = !!event.thread_ts;
    if (inThread) {
      const priorReplies = await client.conversations
        .replies({ channel: event.channel, ts: event.thread_ts, oldest: event.thread_ts })
        .catch(() => ({ messages: [] }));
      const msgs = priorReplies.messages || [];
      mentionThreadHint = msgs.map((m) => m.text || "").join("\n");
      // self:true marks turns authored by the invoking user — those stay
      // authoritative; any other participant's turn is fenced as untrusted data
      // downstream (buildContents) so a third party can't inject instructions
      // via shared-thread history.
      threadHistory = msgs.map((m) => ({
        role: m.bot_id ? "assistant" : "user",
        text: m.text || "",
        self: !m.bot_id && !!event.user && m.user === event.user,
      }));
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
        threadHistory,
        client,
        sessionOpts: {
          userToken,
          channelId: event.channel,
          threadTs: event.thread_ts || event.ts,
          userMessage,
          // Thread already fetched above → don't re-fetch it in the Slack skill.
          skipChannelAndThread: inThread,
          tableauMcpBaseUrl,
          threadHint: mentionThreadHint,
          defaultChannelId: event.channel,
          teamId,
        },
      }),
    ]);
    const skillContext = [localeContext, ...skillResult.contextParts].filter(Boolean).join("\n");
    // Route through the supervisor. With AGENTS_ENABLED off (default) it delegates
    // to getAiResponse with these exact args — behavior-neutral. With the flag on
    // and a TRIAGE intent, the injected triage specialist handles the turn.
    const response = await runSupervised(
      {
        intents,
        aiParams: {
          userMessage,
          threadHistory,
          skillContext: skillContext || undefined,
          uploads: skillResult.uploads,
          sideEffects: skillResult.sideEffects,
          googleSearchActive: skillResult.googleSearchActive,
          systemPromptSections: skillResult.systemPromptSections,
          userToken,
          defaultCanvasChannelId: event.channel,
          teamId,
          useFullModel,
          tableauMcpBaseUrl,
        },
      },
      supervisorDeps,
    );
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
    // Reply is out — now run the deferred canvas side effects (title + write).
    const canvasUpdates = await response.runSideEffects();
    if (response.uploads?.length) {
      try {
        const imageRefs = await postThreadFileUploads(client, {
          channelId: event.channel,
          threadTs,
          uploads: response.uploads,
        });
        if (canvasUpdates?.length && imageRefs.length && userToken) {
          const embedded = await embedImagesInCanvases({
            userToken,
            canvasUpdates,
            imageRefs,
            teamId,
            defaultChannelId: event.channel,
          });
          logger.info(
            `[canvas-images] app_mention embedded ${imageRefs.length} image(s) into ${embedded} canvas(es)`,
          );
        }
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
    const [installation, prefs] = await Promise.all([
      getInstallation(installQuery),
      getUserPreferences(installQuery),
    ]);
    const useInternetSearch = prefs.internetSearch;
    // Effective URL = per-user override, else the host default (TABLEAU_MCP_SERVER).
    const tableauMcpBaseUrl = resolveTableauMcpUrl(prefs.tableauMcpUrl);
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

      // self:true marks the invoking user's own prior turns (authoritative);
      // other participants' turns are fenced as untrusted data in buildContents.
      const invokingUserId = message?.user || null;
      const threadHistory = (repliesRes.messages || []).map((m) => ({
        role: m.bot_id ? "assistant" : "user",
        text: m.text || "",
        self: !m.bot_id && !!invokingUserId && m.user === invokingUserId,
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
            // includeSearch omitted → the Slack skill runs workspace search only
            // when the turn has a slack_search intent (E4).
            contextChannelId,
            teamId,
            tableauMcpBaseUrl,
            threadHint,
            defaultChannelId: contextChannelId || channel,
          },
        }),
      ]);

      const skillContext = [localeContext, ...skillResult.contextParts].filter(Boolean).join("\n");
      // Supervisor pass-through (see app_mention handler above). Neutral with the
      // flag off; routes TRIAGE turns to the injected specialist when on.
      const response = await runSupervised(
        {
          intents,
          aiParams: {
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
            tableauMcpBaseUrl,
          },
        },
        supervisorDeps,
      );

      const replyText =
        installation ? response.text : `${response.text}\n\n---\n${getAuthorizeMessage()}`;
      const { text: notifyText, blocks } = mrkdwnStringToBlocks(replyText);
      await say({ text: notifyText, blocks });
      // Reply is out — now run the deferred canvas side effects (title + write).
      const canvasUpdates = await response.runSideEffects();
      if (response.uploads?.length) {
        try {
          const imageRefs = await postThreadFileUploads(client, {
            channelId: channel,
            threadTs: thread_ts,
            uploads: response.uploads,
          });
          // If a canvas was written this turn, embed the same rendered images
          // into it as file-unfurl links (no re-upload). Best-effort.
          if (canvasUpdates?.length && imageRefs.length && userToken) {
            const embedded = await embedImagesInCanvases({
              userToken,
              canvasUpdates,
              imageRefs,
              teamId,
              defaultChannelId: contextChannelId || channel,
            });
            logger.info(
              `[canvas-images] embedded ${imageRefs.length} image(s) into ${embedded} canvas(es)`,
            );
          }
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
