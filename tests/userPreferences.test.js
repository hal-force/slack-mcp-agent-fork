const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Stub the prisma module (it throws without DATABASE_URL and needs a real DB).
// We inject a fake that counts findUnique calls, then require userPreferences
// so it binds to our stub.
const prismaPath = require.resolve("../src/install-kit/prisma");
let findUniqueCalls = 0;
let lastWhere = null;
let nextRow = null;
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: {
    getPrisma: () => ({
      userPreference: {
        findUnique: async ({ where }) => {
          findUniqueCalls += 1;
          lastWhere = where;
          return nextRow;
        },
      },
    }),
  },
};

const {
  getUserPreferences,
  getTableauMcpUrlOverride,
  getInternetSearchEnabled,
} = require("../src/preferences/userPreferences");

const IQ = { teamId: "T1", userId: "U1", isEnterpriseInstall: false };

test("getUserPreferences returns both prefs from a SINGLE findUnique (E6)", async () => {
  findUniqueCalls = 0;
  nextRow = { tableauMcpUrl: "https://mcp.example.com/x/", internetSearch: true };
  const prefs = await getUserPreferences(IQ);
  assert.equal(findUniqueCalls, 1, "exactly one DB read for both prefs");
  assert.equal(prefs.tableauMcpUrl, "https://mcp.example.com/x"); // trailing slash normalized
  assert.equal(prefs.internetSearch, true);
  assert.equal(lastWhere.id, "T:T1:U1");
});

test("getUserPreferences treats empty/blank URL as no override, false search default", async () => {
  nextRow = { tableauMcpUrl: "   ", internetSearch: false };
  const prefs = await getUserPreferences(IQ);
  assert.equal(prefs.tableauMcpUrl, undefined);
  assert.equal(prefs.internetSearch, false);
});

test("getUserPreferences returns defaults when there is no userId (no query)", async () => {
  findUniqueCalls = 0;
  const prefs = await getUserPreferences({ teamId: "T1" }); // no userId
  assert.equal(findUniqueCalls, 0, "no DB read without a user id");
  assert.deepEqual(prefs, { tableauMcpUrl: undefined, internetSearch: false });
});

test("backward-compat wrappers still return their single value", async () => {
  nextRow = { tableauMcpUrl: "https://a.example.com", internetSearch: true };
  assert.equal(await getTableauMcpUrlOverride(IQ), "https://a.example.com");
  assert.equal(await getInternetSearchEnabled(IQ), true);
});
