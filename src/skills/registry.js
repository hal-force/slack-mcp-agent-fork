/**
 * Skill registry — the authoritative list of what the agent can do.
 *
 * Each skill: { name, functionDeclarations[], handlesToolName(n), dispatch(n, args, sessionOpts), isAvailable(caps) }
 */

const { createCanvasSkill } = require("./canvas");
const { createTableauSkill } = require("./tableau");

/**
 * Build the list of active skills for a request.
 *
 * @param {{
 *   userToken?: string,
 *   defaultChannelId?: string|null,
 *   teamId?: string|null,
 *   tableauMcpBaseUrl?: string,
 * }} sessionOpts
 * @returns {Array<{ name: string, functionDeclarations: object[], handlesToolName: Function, dispatch: Function, isAvailable: Function }>}
 */
function resolveActiveSkills(sessionOpts = {}) {
  const { userToken, defaultChannelId = null, teamId = null, tableauMcpBaseUrl } = sessionOpts;

  const caps = {
    hasUserToken: !!(userToken && String(userToken).trim()),
    tableauEnabled: !!tableauMcpBaseUrl,
  };

  const candidates = [
    createCanvasSkill({ userToken, defaultChannelId, teamId }),
    createTableauSkill({ tableauMcpBaseUrl }),
  ];

  return candidates.filter((skill) => skill.isAvailable(caps));
}

module.exports = { resolveActiveSkills };
