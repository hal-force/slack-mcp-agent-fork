/**
 * Shared helper that extracts the installation lookup key from Slack Bolt
 * body/context/event objects. Eliminates the three near-identical inline
 * constructions in index.js (twice) and workflowAskAi.js.
 */

/**
 * Build the installation query object from whichever Bolt fields are present.
 *
 * @param {object} [body]
 * @param {object} [context]
 * @param {object} [event]
 * @returns {{ teamId: string|undefined, enterpriseId: string|undefined, isEnterpriseInstall: boolean, userId: string|undefined }}
 */
function installQueryFromBoltContext(body, context = {}, event = {}) {
  return {
    teamId:
      body?.team_id ||
      body?.authorizations?.[0]?.team_id ||
      context?.teamId ||
      context?.team?.id ||
      event?.team ||
      event?.team_id,
    enterpriseId:
      body?.enterprise_id ||
      body?.authorizations?.[0]?.enterprise_id ||
      context?.enterpriseId ||
      context?.enterprise?.id ||
      event?.enterprise_id,
    isEnterpriseInstall:
      !!body?.is_enterprise_install ||
      !!body?.authorizations?.[0]?.is_enterprise_install ||
      !!context?.isEnterpriseInstall,
    userId:
      body?.user_id ||
      body?.event?.user ||
      body?.authorizations?.[0]?.user_id ||
      context?.userId ||
      event?.user ||
      event?.user_id,
  };
}

module.exports = { installQueryFromBoltContext };
