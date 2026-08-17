#!/usr/bin/env node
/**
 * Inspect the installation store in Postgres.
 * Usage:
 *   node scripts/check-installation.js                    # list all
 *   node scripts/check-installation.js E081KQN1U7N       # by enterprise ID
 *   node scripts/check-installation.js T081KS1AM60       # by team ID
 *
 * On Heroku: heroku run node scripts/check-installation.js E081KQN1U7N
 */
require("dotenv").config();
const { getPrisma } = require("../src/install-kit/prisma");

const prisma = getPrisma();

async function main() {
  const arg = process.argv[2];
  let rows;

  if (arg) {
    const id = arg.startsWith("E") ? `E:${arg}` : arg.startsWith("T") ? `T:${arg}` : arg;
    const row = await prisma.installation.findUnique({ where: { id } });
    rows = row ? [row] : [];
  } else {
    rows = await prisma.installation.findMany({ orderBy: { id: "asc" } });
  }

  if (rows.length === 0) {
    console.log("No installations found.");
    return;
  }

  for (const r of rows) {
    console.log("\n--- Installation", r.id, "---");
    console.log("  enterpriseId:", r.enterpriseId);
    console.log("  teamId:", r.teamId);
    console.log("  userId:", r.userId, r.userId ? "(per-user)" : "(org-level)");
    // Never print token material (even a prefix leaks the key type + real bytes
    // into console/log history). Presence only.
    console.log("  botToken:", r.botToken ? "(present)" : "(none)");
    console.log("  userToken:", r.userToken ? "(present)" : "(none)");
    console.log("  installerUser:", r.installerUser);
    console.log("  userScope:", r.userScope ? r.userScope.slice(0, 60) + "..." : "(none)");
    console.log("  installedAt:", r.installedAt);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect?.());
