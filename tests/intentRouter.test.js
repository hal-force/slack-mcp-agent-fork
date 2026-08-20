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

// ---- Report requests route to Canvas (long-form deliverable) ----
test("report request routes to Canvas AND Tableau", () => {
  const { intents } = classifyIntent(
    "Can you generate a report on grants for the last year using my OTF data for my executive director? The report should be about three pages.",
    CAPS,
  );
  assert.ok(intents.includes(INTENTS.CANVAS), "report should route to Canvas");
  assert.ok(intents.includes(INTENTS.TABLEAU), "grants/data should still pull Tableau");
});

test("various authoring phrasings trigger Canvas", () => {
  for (const msg of [
    "write a brief on Q1 performance",
    "draft a memo summarizing the grants",
    "put together a detailed analysis for the board",
    "prepare a write-up of the funding trends",
  ]) {
    const { intents } = classifyIntent(msg, CAPS);
    assert.ok(intents.includes(INTENTS.CANVAS), `"${msg}" should route to Canvas`);
  }
});

test("casual 'report' mentions do NOT create a Canvas", () => {
  for (const msg of ["pull the latest report", "did you see the report?", "what's in the annual report"]) {
    const { intents } = classifyIntent(msg, CAPS);
    assert.ok(!intents.includes(INTENTS.CANVAS), `"${msg}" should not trigger Canvas`);
  }
});

test("report routing needs a user token (Canvas is user-scoped)", () => {
  const { intents } = classifyIntent("generate a report on grants", { ...CAPS, hasUserToken: false });
  assert.ok(!intents.includes(INTENTS.CANVAS), "no user token → no Canvas");
});

// ---- TRIAGE intent (nurse-assignment scenario) ----
test("triage vocabulary routes to TRIAGE (when Tableau enabled)", () => {
  for (const msg of [
    "a new patient was just admitted, which nurse should take them?",
    "compare nurse skill match for the current caseload",
    "what's the staffing risk on the unit given acuity?",
  ]) {
    const { intents } = classifyIntent(msg, CAPS);
    assert.ok(intents.includes(INTENTS.TRIAGE), `"${msg}" should route to TRIAGE`);
  }
});

test("TRIAGE is gated on tableauEnabled", () => {
  const { intents } = classifyIntent("which nurse should take this patient?", {
    ...CAPS,
    tableauEnabled: false,
  });
  assert.ok(!intents.includes(INTENTS.TRIAGE));
});

test("generic analytics questions do NOT trigger TRIAGE", () => {
  for (const msg of ["show me the sales numbers", "pull the latest report", "what are my key metrics"]) {
    const { intents } = classifyIntent(msg, CAPS);
    assert.ok(!intents.includes(INTENTS.TRIAGE), `"${msg}" should not be TRIAGE`);
  }
});

test("TRIAGE does not force the full model on its own (baseline-neutral)", () => {
  // A pure triage message (no tableau/canvas/search signal) must not flip
  // useFullModel — otherwise it would change model selection with the flag off.
  const { useFullModel, intents } = classifyIntent("which nurse should take this patient?", CAPS);
  assert.ok(intents.includes(INTENTS.TRIAGE));
  assert.equal(useFullModel, false);
});

test("lexicalWantTableau matches datasource names / analytics language", () => {
  assert.ok(lexicalWantTableau("the OTF Grants Enriched datasource"));
  assert.ok(lexicalWantTableau("published workbook in tableau"));
  assert.ok(!lexicalWantTableau("let's grab coffee later"));
});
