/**
 * Slack skill — pre-fetches Slack workspace context before the LLM call.
 * Wraps buildSlackContext() from slackContext.js.
 */

const { buildSlackContext } = require("../assistant/slackContext");
const { INTENTS } = require("../router/intentRouter");

const SYSTEM_PROMPT_SECTION = `Slack Workspace Context: The Slack context block (channel messages, threads, search results) is your primary source. Always answer from it when relevant. If Slack context is present but incomplete, say what you found before noting the gap. If context is entirely empty, state: "I don't see any recent messages for this."`;

function createSlackSkill() {
  return {
    name: "slack",
    // Slack context is useful on almost every turn; only exclude if purely Tableau with no Slack refs
    matchesIntent: (intents) => {
      if (!Array.isArray(intents)) return true;
      // Skip only if the sole intent is Tableau with no Slack search signal
      if (intents.includes("slackSearch")) return true;
      if (intents.includes("canvas")) return false;
      return true;
    },
    isAvailable: () => true,
    systemPromptSection: SYSTEM_PROMPT_SECTION,

    async execute({ client, sessionOpts, intents }) {
      const {
        userToken,
        channelId,
        threadTs,
        userMessage,
        skipChannelAndThread,
        contextChannelId,
        teamId,
      } = sessionOpts;

      // Only run the (expensive, workspace-wide) search when the turn actually
      // has a search intent — "find/search/who said…". Channel & thread context
      // still loads regardless; this just skips search.messages on the many
      // turns that don't need it (E4). Honor an explicit sessionOpts override.
      const includeSearch =
        typeof sessionOpts.includeSearch === "boolean"
          ? sessionOpts.includeSearch
          : Array.isArray(intents) && intents.includes(INTENTS.SLACK_SEARCH);

      try {
        const contextText = await buildSlackContext(client, {
          userToken,
          channelId,
          threadTs,
          userMessage,
          skipChannelAndThread: skipChannelAndThread || false,
          includeSearch,
          contextChannelId: contextChannelId || null,
          teamId: teamId || null,
        });
        return { contextText: contextText || "", uploads: [], sideEffects: [] };
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.error("[SlackSkill] buildSlackContext error:", err.message || err);
        }
        return { contextText: "", uploads: [], sideEffects: [] };
      }
    },
  };
}

module.exports = { createSlackSkill };
