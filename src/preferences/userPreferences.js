const { getPrisma } = require("../install-kit/prisma");

/**
 * Same id pattern as per-user Installation rows.
 * @param {{ isEnterpriseInstall?: boolean, enterpriseId?: string|null, teamId?: string|null, userId?: string|null }} q
 * @returns {string|null}
 */
function userPreferenceId(q) {
  const userId = q.userId ?? null;
  if (!userId) return null;
  const isEnterpriseInstall = !!q.isEnterpriseInstall;
  const enterpriseId = q.enterpriseId ?? null;
  const teamId = q.teamId ?? null;
  if (isEnterpriseInstall && enterpriseId) return `E:${enterpriseId}:${userId}`;
  if (teamId) return `T:${teamId}:${userId}`;
  return null;
}

/**
 * @param {{ teamId?: string|null, enterpriseId?: string|null, isEnterpriseInstall?: boolean, userId?: string|null }} installQuery
 * @returns {Promise<string|undefined>} Stored override URL, or undefined to use host default
 */
async function getTableauMcpUrlOverride(installQuery) {
  const id = userPreferenceId({
    isEnterpriseInstall: installQuery.isEnterpriseInstall,
    enterpriseId: installQuery.enterpriseId ?? null,
    teamId: installQuery.teamId ?? null,
    userId: installQuery.userId ?? null,
  });
  if (!id) return undefined;
  const row = await getPrisma().userPreference.findUnique({ where: { id } });
  const v = row?.tableauMcpUrl;
  if (v == null || String(v).trim() === "") return undefined;
  return String(v).trim().replace(/\/$/, "");
}

/**
 * @param {{ teamId?: string|null, enterpriseId?: string|null, isEnterpriseInstall?: boolean, userId?: string|null }} installQuery
 * @param {string|null} url - null or empty clears override (use deployment default)
 */
async function setTableauMcpUrlOverride(installQuery, url) {
  const userId = installQuery.userId ?? null;
  if (!userId) throw new Error("userId is required");

  const isEnterpriseInstall = !!installQuery.isEnterpriseInstall;
  const enterpriseId = installQuery.enterpriseId ?? null;
  const teamId = installQuery.teamId ?? null;
  const id = userPreferenceId({ isEnterpriseInstall, enterpriseId, teamId, userId });
  if (!id) throw new Error("teamId or enterpriseId is required for user preferences");

  const normalized =
    url == null || String(url).trim() === "" ? null : String(url).trim().replace(/\/$/, "");

  await getPrisma().userPreference.upsert({
    where: { id },
    create: {
      id,
      enterpriseId,
      teamId,
      userId,
      tableauMcpUrl: normalized,
    },
    update: { tableauMcpUrl: normalized },
  });
}

/**
 * @param {import("@slack/bolt").SlackAction | import("@slack/bolt").SlackViewAction} body
 */
function installQueryFromInteractiveBody(body) {
  return {
    teamId: body.team?.id ?? null,
    enterpriseId: body.enterprise?.id ?? body.team?.enterprise_id ?? null,
    isEnterpriseInstall: !!(body.is_enterprise_install || body.team?.enterprise_id),
    userId: body.user?.id ?? null,
  };
}

module.exports = {
  userPreferenceId,
  getTableauMcpUrlOverride,
  setTableauMcpUrlOverride,
  installQueryFromInteractiveBody,
};
