const { getPrisma } = require("./prisma");

/**
 * Deterministic ID strategy so upsert works with your schema:
 * - Enterprise install: "E:<enterpriseId>" (bot only) or "E:<enterpriseId>:<userId>" (per-user)
 * - Workspace install:  "T:<teamId>" or "T:<teamId>:<userId>"
 */
function makeInstallationId({ isEnterpriseInstall, enterpriseId, teamId, userId }) {
  const base = isEnterpriseInstall
    ? (enterpriseId ? `E:${enterpriseId}` : null)
    : (teamId ? `T:${teamId}` : null);
  if (!base) throw new Error("Install missing enterpriseId or teamId");
  return userId ? `${base}:${userId}` : base;
}

/**
 * Extract the values we persist in your Installation table.
 * @param {object} installation - OAuth installation object
 * @param {{ userId?: string, userTokenOnly?: boolean }} opts - userId for per-user row; userTokenOnly=true omits user fields (org-level bot only)
 */
function toDbRecord(installation, opts = {}) {
  const { userId: explicitUserId, userTokenOnly } = opts;
  const isEnterpriseInstall = !!installation.isEnterpriseInstall;
  const enterpriseId = installation.enterprise?.id ?? null;
  const teamId = installation.team?.id ?? null;
  const uid = explicitUserId ?? installation.user?.id ?? null;

  const id = makeInstallationId({ isEnterpriseInstall, enterpriseId, teamId, userId: userTokenOnly ? null : uid });

  const botToken = installation.bot?.token;
  if (!botToken) {
    throw new Error("Installation missing bot token (installation.bot.token)");
  }

  const scope =
    Array.isArray(installation.bot?.scopes) ? installation.bot.scopes.join(",") : null;
  const userToken = userTokenOnly ? null : (installation.user?.token ?? null);
  const userScope =
    userTokenOnly ? null : (Array.isArray(installation.user?.scopes) ? installation.user.scopes.join(",") : null);

  return {
    id,
    enterpriseId,
    teamId,
    userId: userTokenOnly ? null : uid,
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

      // 1️⃣ Org/workspace-level (bot) – one per enterprise/team; preserve existing userToken for backward compat
      const orgData = toDbRecord(installation, { userTokenOnly: true });
      const orgUpdate = { ...orgData };
      delete orgUpdate.userToken;
      delete orgUpdate.userScope;
      delete orgUpdate.installerUser;
      delete orgUpdate.userId;
      await prisma.installation.upsert({
        where: { id: orgData.id },
        create: orgData,
        update: orgUpdate,
      });
      logger?.info?.("[install] storeInstallation org", { id: orgData.id });

      // 2️⃣ Per-user (bot + user token) – when user scopes were granted
      if (installation.user?.token && installation.user?.id) {
        const userData = toDbRecord(installation);
        await prisma.installation.upsert({
          where: { id: userData.id },
          create: userData,
          update: userData,
        });
        logger?.info?.("[install] storeInstallation user", { id: userData.id, userId: userData.userId });
      } else if (process.env.SLACK_CONTEXT_DEBUG === "1") {
        console.log("[install] storeInstallation: no per-user record (missing installation.user.token or .id)");
      }
    },

    fetchInstallation: async (installQuery) => {
      const prisma = getPrisma();

      const enterpriseId = installQuery.enterpriseId ?? null;
      const teamId = installQuery.teamId ?? null;
      const userId = installQuery.userId ?? null;
      const isEnterpriseInstall = !!installQuery.isEnterpriseInstall;

      logger?.info?.("[install] fetchInstallation", {
        enterpriseId,
        teamId,
        userId,
        isEnterpriseInstall,
      });

      // 1️⃣ Per-user lookup (preferred when userId present)
      if (userId) {
        if (isEnterpriseInstall && enterpriseId) {
          const row = await prisma.installation.findUnique({
            where: { id: `E:${enterpriseId}:${userId}` },
          });
          if (row) return fromDbRecord(row);
        }
        if (teamId) {
          const row = await prisma.installation.findUnique({
            where: { id: `T:${teamId}:${userId}` },
          });
          if (row) return fromDbRecord(row);
        }
      }

      // 2️⃣ Org/workspace-level fallback (bot only)
      if (isEnterpriseInstall && enterpriseId) {
        const row = await prisma.installation.findUnique({
          where: { id: `E:${enterpriseId}` },
        });
        if (row) {
          const result = fromDbRecord(row);
          if (userId && row.installerUser !== userId) {
            result.user = undefined;
          }
          return result;
        }
      }
      if (teamId) {
        const row = await prisma.installation.findUnique({
          where: { id: `T:${teamId}` },
        });
        if (row) {
          const result = fromDbRecord(row);
          if (userId && row.installerUser !== userId) {
            result.user = undefined;
          }
          return result;
        }
        if (isEnterpriseInstall) {
          const byTeam = await prisma.installation.findFirst({
            where: { teamId },
          });
          if (byTeam) {
            const result = fromDbRecord(byTeam);
            if (userId && byTeam.installerUser !== userId) {
              result.user = undefined;
            }
            return result;
          }
        }
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
 * Prefers per-user record when userId is provided.
 *
 * @param {{ teamId?: string, enterpriseId?: string, isEnterpriseInstall?: boolean, userId?: string }} installQuery
 * @returns {Promise<import('@slack/oauth').Installation | null>}
 */
async function getInstallation(installQuery) {
  const prisma = getPrisma();
  const enterpriseId = installQuery.enterpriseId ?? null;
  const teamId = installQuery.teamId ?? null;
  const userId = installQuery.userId ?? null;
  const isEnterpriseInstall = !!installQuery.isEnterpriseInstall;

  if (userId) {
    if (isEnterpriseInstall && enterpriseId) {
      const row = await prisma.installation.findUnique({
        where: { id: `E:${enterpriseId}:${userId}` },
      });
      if (row) return fromDbRecord(row);
    }
    if (teamId) {
      const row = await prisma.installation.findUnique({
        where: { id: `T:${teamId}:${userId}` },
      });
      if (row) return fromDbRecord(row);
    }
  }

  if (isEnterpriseInstall && enterpriseId) {
    const row = await prisma.installation.findUnique({
      where: { id: `E:${enterpriseId}` },
    });
    if (row) {
      const result = fromDbRecord(row);
      if (userId && row.installerUser !== userId) result.user = undefined;
      return result;
    }
  }
  if (teamId) {
    const row = await prisma.installation.findUnique({
      where: { id: `T:${teamId}` },
    });
    if (row) {
      const result = fromDbRecord(row);
      if (userId && row.installerUser !== userId) result.user = undefined;
      return result;
    }
    if (isEnterpriseInstall) {
      const byTeam = await prisma.installation.findFirst({
        where: { teamId },
      });
      if (byTeam) {
        const result = fromDbRecord(byTeam);
        if (userId && byTeam.installerUser !== userId) result.user = undefined;
        return result;
      }
    }
  }
  return null;
}

module.exports = { createInstallationStore, getInstallation };
