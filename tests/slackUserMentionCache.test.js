const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveUserMentions } = require("../src/assistant/slackContext");

// A WebClient stub that returns a per-workspace display name for a user id and
// counts how many times users.info was actually hit (to prove caching works).
function clientFor(token, nameByUid) {
  let calls = 0;
  return {
    token,
    users: {
      info: async ({ user }) => {
        calls += 1;
        const name = nameByUid[user];
        if (!name) return { user: null };
        return { user: { profile: { display_name_normalized: name } } };
      },
    },
    get callCount() {
      return calls;
    },
  };
}

// ---- Fix 2 (security review): user-name cache must be tenant-scoped ----
// Slack member IDs (U…) are unique only WITHIN a workspace/org, not globally,
// and one process serves every installed workspace. A cache keyed on the bare
// uid would let workspace Y render workspace X's cached display name for a
// colliding U-id — a cross-tenant disclosure. The key folds in token + teamId.

test("Fix 2: the SAME user id in two different workspaces resolves to each tenant's own name", async () => {
  const uid = "U0COLLIDE";
  // Two unrelated workspaces that happen to share the member id U0COLLIDE.
  const workspaceX = clientFor("xoxp-team-x", { [uid]: "Alice (X)" });
  const workspaceY = clientFor("xoxp-team-y", { [uid]: "Bob (Y)" });

  const outX = await resolveUserMentions(workspaceX, `hi <@${uid}>`, "TX");
  assert.equal(outX, "hi @Alice (X)", "workspace X sees its own member");

  // Workspace Y must NOT get X's cached "Alice (X)".
  const outY = await resolveUserMentions(workspaceY, `hi <@${uid}>`, "TY");
  assert.equal(outY, "hi @Bob (Y)", "workspace Y sees its OWN member, not X's cached name");

  // Both actually called users.info (no cross-tenant cache hit served the name).
  assert.equal(workspaceX.callCount, 1);
  assert.equal(workspaceY.callCount, 1);
});

test("within the same tenant, a repeat mention is served from cache (no second API call)", async () => {
  const uid = "U0REPEAT";
  const client = clientFor("xoxp-team-z", { [uid]: "Carol" });

  const first = await resolveUserMentions(client, `ping <@${uid}>`, "TZ");
  assert.equal(first, "ping @Carol");
  assert.equal(client.callCount, 1, "first mention hits users.info");

  // A fresh client object for the SAME token+team should still hit the cache.
  const client2 = clientFor("xoxp-team-z", { [uid]: "SHOULD-NOT-BE-CALLED" });
  const second = await resolveUserMentions(client2, `again <@${uid}>`, "TZ");
  assert.equal(second, "again @Carol", "served from the tenant-scoped cache");
  assert.equal(client2.callCount, 0, "no second API call for a cached id in the same tenant");
});

test("text with no mentions is returned unchanged without any API call", async () => {
  const client = clientFor("xoxp-team-n", {});
  const out = await resolveUserMentions(client, "no mentions here", "TN");
  assert.equal(out, "no mentions here");
  assert.equal(client.callCount, 0);
});
