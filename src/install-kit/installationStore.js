const { getPrisma } = require("./prisma");

/**
 * Deterministic ID strategy so upsert works with your schema:
 * - Enterprise install: "E:<enterpriseId>"
 * - Workspace install:  "T:<teamId>"
 */
function makeInstallationId({ isEnterpriseInstall, enterpriseId, teamId }) {
  if (isEnterpriseInstall) {
    if (!enterpriseId) throw new Error("Enterprise install missing enterpriseId");
    return `E:${enterpriseId}`;
  }
  if (!teamId) throw new Error("Workspace install missing teamId");
  return `T:${teamId}`;
}

/**
 * Extract the values we persist in your Installation table.
 * Your schema stores critical values (botToken, ids, scopes, etc.)
 */
function toDbRecord(installation) {
  const isEnterpriseInstall = !!installation.isEnterpriseInstall;
  const enterpriseId = installation.enterprise?.id ?? null;
  const teamId = installation.team?.id ?? null;

  const id = makeInstallationId({ isEnterpriseInstall, enterpriseId, teamId });

  const botToken = installation.bot?.token;
  if (!botToken) {
    throw new Error("Installation missing bot token (installation.bot.token)");
  }

  const scope =
    Array.isArray(installation.bot?.scopes) ? installation.bot.scopes.join(",") : null;
  const userToken = installation.user?.token ?? null;
  const userScope =
    Array.isArray(installation.user?.scopes) ? installation.user.scopes.join(",") : null;

  return {
    id,
    enterpriseId,
    teamId,
    botToken,
    userToken,
    botId: installation.bot?.id ?? null,
    botUserId: installation.bot?.userId ?? null,
    installerUser: installation.user?.id ?? null,
    scope,
    userScope,
    appId: installation.appId ?? null,
    tokenType: installation.tokenType ?? "bot",
  };
}

/**
 * Rebuild the minimal shape Bolt expects for an Installation object.
 * (Bolt/authorize mostly needs bot token + ids; we preserve what we can.)
 */
function fromDbRecord(row) {
  const scopes = row.scope ? row.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const userScopes = row.userScope
    ? row.userScope.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const isEnterpriseInstall = !!row.enterpriseId;

  const userPayload =
    row.userToken || row.installerUser
      ? {
          id: row.installerUser ?? "installer",
          ...(row.userToken && {
            token: row.userToken,
            scopes: userScopes.length ? userScopes : undefined,
          }),
        }
      : undefined;

  return {
    isEnterpriseInstall,
    enterprise: row.enterpriseId ? { id: row.enterpriseId } : undefined,
    team: row.teamId ? { id: row.teamId } : undefined,
    appId: row.appId ?? undefined,
    tokenType: row.tokenType ?? "bot",
    user: userPayload,
    bot: {
      token: row.botToken,
      id: row.botId ?? undefined,
      userId: row.botUserId ?? undefined,
      scopes,
    },
  };
}

function createInstallationStore({ logger } = {}) {
  return {
    storeInstallation: async (installation) => {
      const prisma = getPrisma();
      const data = toDbRecord(installation);

      logger?.info?.("[install] storeInstallation", {
        id: data.id,
        enterpriseId: data.enterpriseId,
        teamId: data.teamId,
      });

      await prisma.installation.upsert({
        where: { id: data.id },
        create: data,
        update: data,
      });
    },

    fetchInstallation: async (installQuery) => {
      const prisma = getPrisma();

      const enterpriseId = installQuery.enterpriseId ?? null;
      const teamId = installQuery.teamId ?? null;
      const isEnterpriseInstall = !!installQuery.isEnterpriseInstall;

      logger?.info?.("[install] fetchInstallation", {
        enterpriseId,
        teamId,
        isEnterpriseInstall,
      });

      // 1️⃣ True enterprise install → enterprise key
      if (isEnterpriseInstall && enterpriseId) {
        const row = await prisma.installation.findUnique({
          where: { id: `E:${enterpriseId}` },
        });
        if (row) return fromDbRecord(row);
      }

      // 2️⃣ Workspace install (even inside Grid) → team key
      if (teamId) {
        const row = await prisma.installation.findUnique({
          where: { id: `T:${teamId}` },
        });
        if (row) return fromDbRecord(row);
      }

      return null;
    },

    deleteInstallation: async (installQuery) => {
      const prisma = getPrisma();

      const enterpriseId = installQuery.enterpriseId ?? null;
      const teamId = installQuery.teamId ?? null;

      const id = enterpriseId
        ? `E:${enterpriseId}`
        : teamId
          ? `T:${teamId}`
          : null;

      if (!id) return;

      logger?.info?.("[install] deleteInstallation", { id, enterpriseId, teamId });

      await prisma.installation.delete({ where: { id } }).catch(() => {});
    },
  };
}

/**
 * Fetch installation by query (for use in handlers when you need user token etc.).
 *
 * @param {{ teamId?: string, enterpriseId?: string, isEnterpriseInstall?: boolean }} installQuery
 * @returns {Promise<import('@slack/oauth').Installation | null>}
 */
async function getInstallation(installQuery) {
  const prisma = getPrisma();
  const enterpriseId = installQuery.enterpriseId ?? null;
  const teamId = installQuery.teamId ?? null;
  const isEnterpriseInstall = !!installQuery.isEnterpriseInstall;

  if (isEnterpriseInstall && enterpriseId) {
    const row = await prisma.installation.findUnique({
      where: { id: `E:${enterpriseId}` },
    });
    if (row) return fromDbRecord(row);
  }
  if (teamId) {
    const row = await prisma.installation.findUnique({
      where: { id: `T:${teamId}` },
    });
    if (row) return fromDbRecord(row);
    // Enterprise Grid: payload may have team_id but not enterprise_id; find by teamId column
    if (isEnterpriseInstall) {
      const byTeam = await prisma.installation.findFirst({
        where: { teamId },
      });
      if (byTeam) return fromDbRecord(byTeam);
    }
  }
  return null;
}

module.exports = { createInstallationStore, getInstallation };
