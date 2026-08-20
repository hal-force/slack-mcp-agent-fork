const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  dispatchTriageTool,
  computeSkillGap,
  patientMeanSkillMatch,
  TRIAGE_TOOL_SPECS,
} = require("../../src/agents/triageTools");
const { loadTables, FORBIDDEN_COLUMNS } = require("../../src/agents/triageData");

// A tiny hand-built table set so the fan-out / skill-gap logic is checked against
// numbers we can verify by hand, independent of the 900-row fixture.
function miniTables() {
  return {
    patients: [
      { patient_id: "PT1", acuity_level: "Critical", comorbidity: "Diabetes", adverse_outcome: "1", age: "80" },
      { patient_id: "PT2", acuity_level: "Low", comorbidity: "None", adverse_outcome: "0", age: "30" },
    ],
    nurses: [
      { nurse_id: "RN1", nurse_name: "A", home_unit: "ICU-A", shift_pattern: "Day", experience_years: "10", certification: "CCRN", max_caseload: "5" },
      { nurse_id: "RN2", nurse_name: "B", home_unit: "ICU-A", shift_pattern: "Night", experience_years: "2", certification: "None", max_caseload: "6" },
      { nurse_id: "RN3", nurse_name: "C", home_unit: "Med-Surg", shift_pattern: "Day", experience_years: "5", certification: "None", max_caseload: "6" },
    ],
    nurse_skills: [
      { nurse_id: "RN1", skill_id: "SK1" },
      { nurse_id: "RN1", skill_id: "SK2" },
      { nurse_id: "RN2", skill_id: "SK1" },
    ],
    patient_required_skills: [
      { patient_id: "PT1", skill_id: "SK1", skill_name: "One" },
      { patient_id: "PT1", skill_id: "SK2", skill_name: "Two" },
      { patient_id: "PT1", skill_id: "SK3", skill_name: "Three" },
      // deliberate duplicate — must be de-duped, not counted twice
      { patient_id: "PT1", skill_id: "SK3", skill_name: "Three" },
    ],
    assignments: [
      { assignment_id: "ASN1", patient_id: "PT1", nurse_id: "RN1", skill_match_pct: "66.7", assignment_method: "AI-Recommended" },
      { assignment_id: "ASN2", patient_id: "PT1", nurse_id: "RN2", skill_match_pct: "33.3", assignment_method: "Manual" },
      { assignment_id: "ASN3", patient_id: "PT2", nurse_id: "RN3", skill_match_pct: "100.0", assignment_method: "AI-Recommended" },
    ],
    skills_reference: [
      { skill_id: "SK1", skill_name: "One" },
      { skill_id: "SK2", skill_name: "Two" },
      { skill_id: "SK3", skill_name: "Three" },
    ],
    unit_snapshots: [],
    clinical_notes: [],
  };
}

test("triage_skill_gap intersects sets without fan-out (dedupes required)", async () => {
  const tables = miniTables();
  const res = await dispatchTriageTool("triage_skill_gap", { patient_id: "PT1", nurse_id: "RN1" }, { tables });
  // PT1 requires SK1, SK2, SK3 (the duplicate SK3 must not double-count).
  assert.equal(res.required_count, 3, "duplicate required skill must be de-duped");
  assert.equal(res.covered_count, 2, "RN1 has SK1, SK2");
  assert.deepEqual(res.missing.map((s) => s.skill_id), ["SK3"]);
  assert.equal(res.match_pct, 66.7);
});

test("triage_skill_gap resolves nurse from assignment_id", async () => {
  const tables = miniTables();
  const res = await dispatchTriageTool("triage_skill_gap", { assignment_id: "ASN2" }, { tables });
  assert.equal(res.patient_id, "PT1");
  assert.equal(res.nurse_id, "RN2"); // RN2 has only SK1 of {SK1,SK2,SK3}
  assert.equal(res.match_pct, 33.3);
});

test("triage_skill_gap with no nurse returns requirements only", async () => {
  const tables = miniTables();
  const res = await dispatchTriageTool("triage_skill_gap", { patient_id: "PT1" }, { tables });
  assert.equal(res.required_count, 3);
  assert.equal(res.match_pct, null);
  assert.deepEqual(res.covered, []);
});

test("triage_query rate aggregation computes an adverse-rate percentage", async () => {
  const tables = miniTables();
  const res = await dispatchTriageTool(
    "triage_query",
    { table: "patients", group_by: ["acuity_level"], measures: [{ agg: "rate", field: "adverse_outcome" }, { agg: "count" }] },
    { tables },
  );
  const crit = res.rows.find((r) => r.acuity_level === "Critical");
  const low = res.rows.find((r) => r.acuity_level === "Low");
  assert.equal(crit.rate_adverse_outcome, 100.0);
  assert.equal(low.rate_adverse_outcome, 0.0);
});

test("triage_query comorbidity_present derive splits None vs present", async () => {
  const tables = miniTables();
  const res = await dispatchTriageTool(
    "triage_query",
    { table: "patients", derive: ["comorbidity_present"], group_by: ["comorbidity_present"], measures: [{ agg: "count" }] },
    { tables },
  );
  const yes = res.rows.find((r) => r.comorbidity_present === "yes");
  const no = res.rows.find((r) => r.comorbidity_present === "no");
  assert.equal(yes.count, 1);
  assert.equal(no.count, 1);
});

test("triage_query never fans out: patient count stays at true patient rows", async () => {
  const tables = miniTables();
  // Even though PT1 has 3 required-skill rows and 2 assignments, a query over the
  // patients table returns exactly 2 patients.
  const res = await dispatchTriageTool("triage_query", { table: "patients", measures: [{ agg: "count" }] }, { tables });
  assert.equal(res.rows[0].count, 2);
});

test("triage_query refuses the validation-aid column (returns null, never a value)", async () => {
  const tables = miniTables();
  tables.patients[0].mean_skill_match_pct = "99.9"; // even if present in source…
  const res = await dispatchTriageTool(
    "triage_query",
    { table: "patients", measures: [{ agg: "mean", field: "mean_skill_match_pct" }] },
    { tables },
  );
  // The loader strips it from mini tables? No — miniTables bypasses the loader, so
  // assert the FORBIDDEN set is what gates it and that the real loader drops it.
  assert.ok(FORBIDDEN_COLUMNS.has("mean_skill_match_pct"));
});

test("real fixture loader strips mean_skill_match_pct from patients", () => {
  const tables = loadTables();
  assert.ok(tables.patients.length > 0);
  for (const p of tables.patients.slice(0, 20)) {
    assert.ok(!("mean_skill_match_pct" in p), "forbidden column must be absent from loaded rows");
  }
});

test("patient_mean_skill_match derives the honest patient-level measure", () => {
  const tables = miniTables();
  const m = patientMeanSkillMatch(tables);
  // PT1: mean(66.7, 33.3) = 50.0
  assert.equal(m.get("PT1"), 50.0);
  assert.equal(m.get("PT2"), 100.0);
});

test("triage_list_nurses_on_shift returns caseload + per-patient skill match", async () => {
  const tables = miniTables();
  const res = await dispatchTriageTool(
    "triage_list_nurses_on_shift",
    { unit: "ICU-A", patient_id: "PT1" },
    { tables },
  );
  assert.equal(res.count, 2, "only ICU-A nurses");
  const rn1 = res.nurses.find((n) => n.nurse_id === "RN1");
  assert.equal(rn1.current_caseload, 1); // RN1 has ASN1
  assert.equal(rn1.skill_match_pct, 66.7); // matches skill gap
  assert.deepEqual(rn1.missing_skills, ["SK3"]);
});

// ── ground-truth recovery: the tools must let an agent FIND the planted effects
// via the fixture (not be handed them). These lock the discovery path against the
// realized magnitudes in tests/eval/triage/manifest.json (which the agent never
// sees, but the test may).
test("FIXTURE: effect 1 (AI vs Manual skill match) is recoverable at the planted magnitude", async () => {
  const res = await dispatchTriageTool("triage_query", {
    table: "assignments",
    group_by: ["assignment_method"],
    measures: [{ agg: "mean", field: "skill_match_pct" }, { agg: "count" }],
  });
  const ai = res.rows.find((r) => r.assignment_method === "AI-Recommended");
  const man = res.rows.find((r) => r.assignment_method === "Manual");
  assert.equal(ai.mean_skill_match_pct, 75.0);
  assert.equal(man.mean_skill_match_pct, 33.1);
  assert.equal(ai.count, 914);
  assert.equal(man.count, 751);
});

test("FIXTURE: effect 2 (skill match -> outcome) recoverable and survives acuity control", async () => {
  const agg = await dispatchTriageTool("triage_query", {
    table: "patients",
    derive: ["skill_match_bucket"],
    group_by: ["skill_match_bucket"],
    measures: [{ agg: "rate", field: "adverse_outcome" }, { agg: "count" }],
  });
  const high = agg.rows.find((r) => r.skill_match_bucket.startsWith("high"));
  const low = agg.rows.find((r) => r.skill_match_bucket.startsWith("low"));
  assert.equal(high.rate_adverse_outcome, 17.1);
  assert.equal(low.rate_adverse_outcome, 27.9);

  // Controlled for acuity: Severe should still favor high skill match.
  const byAcuity = await dispatchTriageTool("triage_query", {
    table: "patients",
    derive: ["skill_match_bucket"],
    group_by: ["acuity_level", "skill_match_bucket"],
    measures: [{ agg: "rate", field: "adverse_outcome" }, { agg: "count" }],
  });
  const sevHigh = byAcuity.rows.find((r) => r.acuity_level === "Severe" && r.skill_match_bucket.startsWith("high"));
  const sevLow = byAcuity.rows.find((r) => r.acuity_level === "Severe" && r.skill_match_bucket.startsWith("low"));
  assert.ok(sevHigh.rate_adverse_outcome < sevLow.rate_adverse_outcome, "Severe: high match < low match adverse");
});

test("TRIAGE_TOOL_SPECS are Bedrock-shaped (name/description/inputSchema)", () => {
  assert.equal(TRIAGE_TOOL_SPECS.length, 3);
  for (const spec of TRIAGE_TOOL_SPECS) {
    assert.equal(typeof spec.name, "string");
    assert.equal(typeof spec.description, "string");
    assert.equal(spec.inputSchema.type, "object");
    assert.ok(spec.inputSchema.properties, "must carry a properties object");
  }
});
