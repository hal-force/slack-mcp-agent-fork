const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildSlackContext, parseChannelRefs } = require("../src/assistant/slackContext");

// A bot client stub that FAILS the test if any read method is called — the whole
// point of S6 is that named-channel / search reads never touch the bot token.
function strictBotClient() {
  const boom = (name) => () => {
    throw new Error(`bot client must not be used for user-scoped read: ${name}`);
  };
  return {
    conversations: {
      info: boom("conversations.info"),
      history: boom("conversations.history"),
      replies: boom("conversations.replies"),
      list: boom("conversations.list"),
    },
    search: { messages: boom("search.messages") },
    users: { info: boom("users.info") },
  };
}

test("parseChannelRefs separates <#ID|name> links from plain #names", () => {
  const { ids, names } = parseChannelRefs("see <#C123ABC|general> and #alerts please");
  assert.deepEqual(ids, ["C123ABC"]);
  assert.deepEqual(names, ["alerts"]);
});

test("parseChannelRefs ignores purely numeric #refs (E5) but keeps real names", () => {
  const { names } = parseChannelRefs("compare #q4-2024 vs #1 and #2024, see #a");
  // "#1" and "#2024" have no letters → not channel refs (no wasted lookup).
  assert.ok(names.includes("q4-2024"));
  assert.ok(names.includes("a"));
  assert.ok(!names.includes("1"));
  assert.ok(!names.includes("2024"));
});

test("named-channel read without a user token refuses and records an access error (S6)", async () => {
  const channelAccessErrors = [];
  const out = await buildSlackContext(strictBotClient(), {
    userToken: undefined, // no user token
    userMessage: "summarize #finance-private",
    includeSearch: true,
    channelAccessErrors,
  });

  // The bot client was never used (strict stub would have thrown), and the
  // named-channel read was refused with a clear access problem.
  assert.equal(channelAccessErrors.length, 1);
  assert.equal(channelAccessErrors[0].channelLabel, "#finance-private");
  assert.match(channelAccessErrors[0].error, /not_authorized_without_user_token/);
  // The returned context surfaces the access problem (drives the reinstall hint).
  assert.match(out, /Could not load message history/);
});

test("<#ID> link read without a user token is also refused (S6)", async () => {
  const channelAccessErrors = [];
  await buildSlackContext(strictBotClient(), {
    userToken: "   ", // whitespace-only = no real token
    userMessage: "what's in <#C999XYZ|secret-room>?",
    channelAccessErrors,
  });
  assert.equal(channelAccessErrors.length, 1);
  assert.equal(channelAccessErrors[0].channelId, "C999XYZ");
});

test("no channel refs + no user token → empty context, bot client untouched", async () => {
  const out = await buildSlackContext(strictBotClient(), {
    userToken: undefined,
    userMessage: "hi there",
    includeSearch: true,
  });
  assert.equal(out, "");
});
