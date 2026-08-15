const { test } = require("node:test");
const assert = require("node:assert/strict");

const { classifyIntent, lexicalWantTableau, INTENTS } = require("../src/router/intentRouter");

const CAPS = { tableauEnabled: true, hasUserToken: true, internetSearch: false };

// ---- Regression: the exact conversation the user hit ----
// "Can you find my OTF grants data for me?" contained no v1 Tableau keyword
// (tableau/datasource/workbook/dashboard/pulse), so it was routed to Slack
// search only and the datasource catalog was never fetched. The follow-up
// "you literally showed me OTF Grants Enriched" also lacked a keyword, so
// thread continuity never kicked in either.

test("REGRESSION: 'find my OTF grants data' routes to Tableau", () => {
  const { intents } = classifyIntent("Can you find my OTF grants data for me?", CAPS);
  assert.ok(intents.includes(INTENTS.TABLEAU), "should route data question to Tableau");
});

test("broadened keywords: natural data questions trigger Tableau", () => {
  for (const msg of [
    "show me the sales numbers",
    "what are my key metrics this quarter",
    "pull the latest report",
    "can I see the analytics for grants",
    "give me the figures for revenue",
    "what datasets do I have",
  ]) {
    const { intents } = classifyIntent(msg, CAPS);
    assert.ok(intents.includes(INTENTS.TABLEAU), `"${msg}" should route to Tableau`);
  }
});

test("thread continuity: keyword-less follow-up stays in Tableau mode", () => {
  const threadHint = [
    "Can you find my OTF grants data?",
    "Here are your data sources: OTF Grants Enriched (luid abc), Superstore",
  ].join("\n");
  const { intents } = classifyIntent("you literally showed me OTF Grants Enriched", CAPS, threadHint);
  assert.ok(
    intents.includes(INTENTS.TABLEAU),
    "follow-up in a Tableau thread should re-route to Tableau",
  );
});

test("thread continuity via a prior datasource LUID in the thread", () => {
  const threadHint = "earlier: 65ee6d6a-6541-43ee-abef-cd6a5027c1d7";
  const { intents } = classifyIntent("what about last quarter?", CAPS, threadHint);
  assert.ok(intents.includes(INTENTS.TABLEAU));
});

test("no thread hint + generic chit-chat stays conversational", () => {
  const { intents } = classifyIntent("thanks, that's great!", CAPS);
  assert.ok(intents.includes(INTENTS.CONVERSATIONAL));
  assert.ok(!intents.includes(INTENTS.TABLEAU));
});

test("Tableau gating respects capability flag (disabled → never routes)", () => {
  const { intents } = classifyIntent("show me my tableau dashboard", {
    ...CAPS,
    tableauEnabled: false,
  });
  assert.ok(!intents.includes(INTENTS.TABLEAU));
});

test("useFullModel is set when Tableau intent is present", () => {
  const { useFullModel } = classifyIntent("show me the grants metrics", CAPS);
  assert.equal(useFullModel, true);
});

test("lexicalWantTableau matches datasource names / analytics language", () => {
  assert.ok(lexicalWantTableau("the OTF Grants Enriched datasource"));
  assert.ok(lexicalWantTableau("published workbook in tableau"));
  assert.ok(!lexicalWantTableau("let's grab coffee later"));
});
