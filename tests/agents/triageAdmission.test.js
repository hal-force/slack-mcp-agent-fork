const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildAdmissionNotice, buildRecommendationCard, SYNTH_TAG } = require("../../src/agents/triageCard");
const { rankNurses, handleAdmission } = require("../../src/agents/triageAdmission");

function miniTables() {
  return {
    patients: [
      { patient_id: "PT1", patient_name: "Test Patient", age: "80", sex: "F", acuity_level: "Critical", diagnosis: "Post-CABG Day 1", comorbidity: "Diabetes", symptoms: "chest pain" },
    ],
    nurses: [
      { nurse_id: "RN1", nurse_name: "Alice", home_unit: "ICU-A", shift_pattern: "Day", experience_years: "10", certification: "CCRN", max_caseload: "5" },
      { nurse_id: "RN2", nurse_name: "Bob", home_unit: "ICU-A", shift_pattern: "Day", experience_years: "2", certification: "None", max_caseload: "4" },
      { nurse_id: "RN3", nurse_name: "Cara", home_unit: "Med-Surg", shift_pattern: "Day", experience_years: "5", certification: "None", max_caseload: "6" },
    ],
    nurse_skills: [
      { nurse_id: "RN1", skill_id: "SK1" },
      { nurse_id: "RN1", skill_id: "SK2" },
      { nurse_id: "RN2", skill_id: "SK1" },
    ],
    patient_required_skills: [
      { patient_id: "PT1", skill_id: "SK1", skill_name: "One" },
      { patient_id: "PT1", skill_id: "SK2", skill_name: "Two" },
    ],
    assignments: [
      // RN1 already carries a load; RN2 is empty. RN1 has better skill match though.
      { assignment_id: "A1", patient_id: "PTX", nurse_id: "RN1", skill_match_pct: "50", assignment_method: "Manual" },
      { assignment_id: "A2", patient_id: "PTY", nurse_id: "RN1", skill_match_pct: "50", assignment_method: "Manual" },
      { assignment_id: "A3", patient_id: "PTZ", nurse_id: "RN1", skill_match_pct: "50", assignment_method: "Manual" },
    ],
    skills_reference: [
      { skill_id: "SK1", skill_name: "One" },
      { skill_id: "SK2", skill_name: "Two" },
    ],
    unit_snapshots: [],
    clinical_notes: [],
  };
}

// ── card renderers (pure) ────────────────────────────────────────────────────
test("admission notice carries patient facts and the synthetic/advisory tag", () => {
  const { text, blocks } = buildAdmissionNotice(miniTables().patients[0]);
  assert.match(text, /PT1/);
  assert.equal(blocks[0].type, "header");
  assert.match(blocks[0].text.text, /New admission: PT1/);
  const body = blocks[1].text.text;
  assert.match(body, /Critical/);
  assert.match(body, /Post-CABG/);
  assert.match(body, /Diabetes/);
  const ctx = blocks[blocks.length - 1];
  assert.equal(ctx.type, "context");
  assert.match(ctx.elements[0].text, /SYNTHETIC/);
  assert.equal(ctx.elements[0].text, SYNTH_TAG);
});

test("recommendation card lists ranked candidates and headlines the top pick", () => {
  const ranking = [
    { nurse_id: "RN1", nurse_name: "Alice", skill_match_pct: 100, current_caseload: 3, max_caseload: 5, missing_skills: [] },
    { nurse_id: "RN2", nurse_name: "Bob", skill_match_pct: 50, current_caseload: 0, max_caseload: 4, missing_skills: ["SK2"] },
  ];
  const { text, blocks } = buildRecommendationCard(ranking, { patient_id: "PT1" });
  assert.match(text, /Recommend Alice RN1 for PT1/);
  const listBlock = blocks.find((b) => b.type === "section" && /RANKED CANDIDATES/.test(b.text.text));
  assert.match(listBlock.text.text, /Alice \(RN1\)/);
  assert.match(listBlock.text.text, /skill match 100%/);
  assert.match(listBlock.text.text, /caseload 0\/4/);
  assert.match(listBlock.text.text, /missing SK2/);
});

test("recommendation card handles an empty ranking gracefully", () => {
  const { text, blocks } = buildRecommendationCard([], { patient_id: "PT9" });
  assert.match(text, /No recommendation for PT9/);
  assert.ok(blocks.some((b) => b.type === "section" && /No candidate nurse/.test(b.text.text)));
});

// ── deterministic ranker ─────────────────────────────────────────────────────
test("rankNurses scores skill match minus workload and orders best-first", async () => {
  const tables = miniTables();
  const { patient, ranking } = await rankNurses("PT1", { unit: "ICU-A", toolOpts: { tables } });
  assert.equal(patient.patient_id, "PT1");
  assert.equal(ranking.length, 2, "only ICU-A nurses");
  // RN1: match 100, caseload 3/5 (loadFrac .6) → 100 − 20*.6 = 88.
  // RN2: match 50, caseload 0 → 50. RN1 wins despite higher load.
  assert.equal(ranking[0].nurse_id, "RN1");
  assert.equal(ranking[0].score, 88);
  assert.equal(ranking[1].nurse_id, "RN2");
  assert.equal(ranking[1].score, 50);
});

test("rankNurses workload penalty can flip the order when skill match is close", async () => {
  const tables = miniTables();
  // Make RN2 nearly as skilled (give it SK2 too) so workload decides.
  tables.nurse_skills.push({ nurse_id: "RN2", skill_id: "SK2" });
  const { ranking } = await rankNurses("PT1", { unit: "ICU-A", toolOpts: { tables } });
  // RN1: 100 − 20*.6 = 88. RN2: 100 − 0 = 100. Now RN2 (unloaded) wins.
  assert.equal(ranking[0].nurse_id, "RN2");
  assert.equal(ranking[0].score, 100);
});

// ── orchestration ────────────────────────────────────────────────────────────
test("handleAdmission posts a notice then a card via the injected poster", async () => {
  const tables = miniTables();
  const posts = [];
  const res = await handleAdmission(
    { patientId: "PT1", channel: "C_TRIAGE", unit: "ICU-A" },
    { postMessage: async (m) => { posts.push(m); return { ok: true, ts: `${posts.length}` }; }, rankOpts: { toolOpts: { tables } } },
  );
  assert.equal(posts.length, 2, "one notice + one card");
  assert.match(posts[0].text, /New admission: PT1/);
  assert.match(posts[1].text, /Recommend .*RN1 for PT1/);
  assert.equal(res.ranking[0].nurse_id, "RN1");
});

test("handleAdmission requires an injected poster (never posts implicitly)", async () => {
  await assert.rejects(
    () => handleAdmission({ patientId: "PT1", channel: "C" }, {}),
    /postMessage is required/,
  );
});

test("handleAdmission attaches specialist narrative but survives specialist failure", async () => {
  const tables = miniTables();
  const posts = [];
  // A specialist that throws — the card must still post.
  const res = await handleAdmission(
    { patientId: "PT1", channel: "C_TRIAGE", unit: "ICU-A" },
    {
      postMessage: async (m) => { posts.push(m); return { ok: true }; },
      specialist: { run: async () => { throw new Error("LLM down"); } },
      rankOpts: { toolOpts: { tables } },
    },
  );
  assert.equal(posts.length, 2, "card still posts despite specialist error");
  assert.ok(res.card);
});

test("handleAdmission includes specialist prose on the card when it succeeds", async () => {
  const tables = miniTables();
  const posts = [];
  await handleAdmission(
    { patientId: "PT1", channel: "C_TRIAGE", unit: "ICU-A" },
    {
      postMessage: async (m) => { posts.push(m); return { ok: true }; },
      specialist: { run: async () => ({ text: "RN1 is the strongest skill fit; the unit stays within ratio.", structured: { mode: "recommendation" } }) },
      rankOpts: { toolOpts: { tables } },
    },
  );
  const card = posts[1];
  assert.ok(card.blocks.some((b) => b.type === "section" && /strongest skill fit/.test(b.text.text)));
});
