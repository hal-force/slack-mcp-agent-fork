/**
 * Skill registry — the authoritative list of what the agent can do.
 *
 * Each skill: { name, execute(input) → SkillResult, systemPromptSection, matchesIntent(intents), isAvailable(caps) }
 */

const { createCanvasSkill } = require("./canvas");
const { createTableauSkill } = require("./tableau");
const { createSlackSkill } = require("./slack");
const { createInternetSearchSkill } = require("./internetSearch");

/**
 * Build the list of all skill candidates for a request.
 *
 * @param {{
 *   userToken?: string,
 *   defaultChannelId?: string|null,
 *   teamId?: string|null,
 *   tableauMcpBaseUrl?: string,
 *   internetSearchEnabled?: boolean,
 * }} sessionOpts
 * @returns {Array<object>}
 */
function resolveActiveSkills(sessionOpts = {}) {
  const { userToken, defaultChannelId = null, teamId = null, tableauMcpBaseUrl, internetSearchEnabled = false } = sessionOpts;

  const caps = {
    hasUserToken: !!(userToken && String(userToken).trim()),
    tableauEnabled: !!tableauMcpBaseUrl,
    internetSearchEnabled,
  };

  const candidates = [
    createSlackSkill(),
    createCanvasSkill(),
    createTableauSkill(),
    createInternetSearchSkill(),
  ];

  return candidates.filter((skill) => skill.isAvailable(caps));
}

/**
 * Run all skills whose matchesIntent() returns true, in parallel.
 *
 * @param {Array<object>} activeSkills - from resolveActiveSkills()
 * @param {string[]} intents - from classifyIntent()
 * @param {{
 *   userMessage: string,
 *   threadHistory?: Array<{role: string, text: string}>,
 *   client: object,
 *   sessionOpts: object,
 * }} sessionInput
 * @returns {Promise<{
 *   contextParts: string[],
 *   uploads: Array<{buffer: Buffer, filename: string, title?: string}>,
 *   sideEffects: Array<{type: string, payload: object}>,
 *   googleSearchActive: boolean,
 *   systemPromptSections: string[],
 * }>}
 */
async function executeActiveSkills(activeSkills, intents, sessionInput) {
  const matching = activeSkills.filter(
    (s) => !s.matchesIntent || s.matchesIntent(intents),
  );

  const results = await Promise.all(
    matching.map((skill) =>
      skill
        .execute({ ...sessionInput, intents })
        .catch((err) => {
          if (process.env.NODE_ENV !== "production") {
            console.error(`[registry] ${skill.name} execute error:`, err?.message || err);
          }
          return { contextText: "", uploads: [], sideEffects: [] };
        }),
    ),
  );

  const contextParts = [];
  const uploads = [];
  const sideEffects = [];
  const systemPromptSections = [];
  let googleSearchActive = false;

  for (let i = 0; i < matching.length; i++) {
    const skill = matching[i];
    const result = results[i];
    if (skill.systemPromptSection) systemPromptSections.push(skill.systemPromptSection);
    if (result.contextText) contextParts.push(result.contextText);
    if (result.uploads?.length) uploads.push(...result.uploads);
    if (result.sideEffects?.length) sideEffects.push(...result.sideEffects);
    if (result.googleSearchActive) googleSearchActive = true;
  }

  return { contextParts, uploads, sideEffects, googleSearchActive, systemPromptSections };
}

module.exports = { resolveActiveSkills, executeActiveSkills };
