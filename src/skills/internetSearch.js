/**
 * Internet search skill — Gemini-specific feature.
 * Does no API work itself; signals the LLM assembly layer to enable googleSearch grounding.
 */

const SYSTEM_PROMPT_SECTION = `Internet Search: When Internet Search is ACTIVE, use Google Search immediately for any real-time, current-events, weather, price, or factual look-up that needs live data. Do not say you lack web access. Only invoke web search when Slack and Tableau sources genuinely cannot answer the question, or the user explicitly asks for current events or public documentation.`;

function createInternetSearchSkill() {
  return {
    name: "internetSearch",
    matchesIntent: (intents) =>
      Array.isArray(intents) && intents.includes("internetSearch"),
    isAvailable: (caps) => !!caps.internetSearchEnabled,
    systemPromptSection: SYSTEM_PROMPT_SECTION,

    async execute() {
      return { contextText: "", uploads: [], sideEffects: [], googleSearchActive: true };
    },
  };
}

module.exports = { createInternetSearchSkill };
