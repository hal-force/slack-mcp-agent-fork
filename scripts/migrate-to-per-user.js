#!/usr/bin/env node
/**
 * Migrate existing org-level installations (with userToken) to per-user records.
 * Run once after deploying per-user support.
 *
 *   node scripts/migrate-to-per-user.js
 *   heroku run node scripts/migrate-to-per-user.js -a slack-mcp-agent
 */
require("dotenv").config();
const { getPrisma } = require("../src/install-kit/prisma");

const prisma = getPrisma();

async function main() {
  const rows = await prisma.installation.findMany({
    where: {
      userId: null,
      userToken: { not: null },
      installerUser: { not: null },
    },
  });

  if (rows.length === 0) {
    console.log("No org-level rows with userToken to migrate.");
    return;
  }

  for (const row of rows) {
    const perUserId = `${row.id}:${row.installerUser}`;
    const existing = await prisma.installation.findUnique({
      where: { id: perUserId },
    });
    if (existing) {
      console.log("Skip (exists):", perUserId);
      continue;
    }
    await prisma.installation.create({
      data: {
        id: perUserId,
        enterpriseId: row.enterpriseId,
        teamId: row.teamId,
        userId: row.installerUser,
        botToken: row.botToken,
        userToken: row.userToken,
        botId: row.botId,
        botUserId: row.botUserId,
        installerUser: row.installerUser,
        scope: row.scope,
        userScope: row.userScope,
        appId: row.appId,
        tokenType: row.tokenType,
      },
    });
    console.log("Created:", perUserId, "for user", row.installerUser);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect?.());
