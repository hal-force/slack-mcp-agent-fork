/**
 * Slack skill — pre-fetches Slack workspace context before the LLM call.
 * Wraps buildSlackContext() from slackContext.js.
 */

const { buildSlackContext } = require("../assistant/slackContext");

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

      try {
        const contextText = await buildSlackContext(client, {
          userToken,
          channelId,
          threadTs,
          userMessage,
          skipChannelAndThread: skipChannelAndThread || false,
          includeSearch: true,
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
