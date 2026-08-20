const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseVdsData,
  parseMetadataCaptions,
  buildCaptionResolver,
  canonKey,
  resolveDatasourceMap,
  loadTablesFromMcp,
  makeMcpDispatchTool,
} = require("../../src/agents/triageMcpData");
const { FORBIDDEN_COLUMNS } = require("../../src/agents/triageData");

// ── A mock MCP callTool. Serves metadata (captions) + VDS query rows per LUID. ──
// Captions are deliberately Title-Cased with spaces ("Patient Id") to prove the
// canonical-name resolver copes with Tableau's caption styling.
function titleCaption(col) {
  return col.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function makeMockMcp(tablesByLuid, { includeForbidden = false } = {}) {
  const calls = [];
  const callTool = async (name, input) => {
    calls.push({ name, input });
    const luid = input.datasourceLuid;
    const rows = tablesByLuid[luid] || [];
    const cols = rows.length ? Object.keys(rows[0]) : [];
    if (name === "get-datasource-metadata") {
      const fields = cols.map((c) => ({ fieldCaption: titleCaption(c) }));
      return { text: JSON.stringify({ data: fields }) };
    }
    if (name === "query-datasource") {
      // Return only the requested fields, keyed by their (title-cased) caption.
      const requested = (input.query.fields || []).map((f) => f.fieldCaption);
      const data = rows.map((r) => {
        const o = {};
        for (const cap of requested) {
          const col = cap.toLowerCase().replace(/ /g, "_");
          if (col in r) o[cap] = r[col];
        }
        return o;
      });
      return { text: JSON.stringify({ data }) };
    }
    return { text: "" };
  };
  return { callTool, calls };
}

// ── pure parsers ──────────────────────────────────────────────────────────────
test("parseVdsData reads {data:[...]} and a bare array; tolerates junk", () => {
  assert.deepEqual(parseVdsData('{"data":[{"a":1}]}'), [{ a: 1 }]);
  assert.deepEqual(parseVdsData('[{"b":2}]'), [{ b: 2 }]);
  assert.deepEqual(parseVdsData("not json"), []);
  assert.deepEqual(parseVdsData(""), []);
});

test("parseMetadataCaptions handles several server shapes", () => {
  assert.deepEqual(parseMetadataCaptions('{"data":[{"fieldCaption":"Patient Id"}]}'), ["Patient Id"]);
  assert.deepEqual(parseMetadataCaptions('{"fields":[{"name":"acuity_level"}]}'), ["acuity_level"]);
  assert.deepEqual(parseMetadataCaptions('["skill_id","skill_name"]'), ["skill_id", "skill_name"]);
  assert.deepEqual(parseMetadataCaptions("garbage"), []);
});

test("parseMetadataCaptions reads the real Tableau VDS fieldGroups shape", () => {
  // This is the exact shape federal-tableau-mcp's get-datasource-metadata returns
  // (v4 VDS): one fieldGroup per logical table, fields keyed by `name`. The parser
  // silently returned [] for this before the M4d live-run fix.
  const meta = JSON.stringify({
    datasourceModel: { logicalTables: [{ logicalTableId: "Extract_X", caption: "Extract" }] },
    fieldGroups: [
      {
        logicalTableId: "Extract_X",
        fields: [
          { name: "nurse_id", dataType: "STRING", role: "DIMENSION" },
          { name: "shift_pattern", dataType: "STRING", role: "DIMENSION" },
          { name: "skill_count", dataType: "INTEGER", role: "MEASURE" },
        ],
      },
    ],
  });
  assert.deepEqual(parseMetadataCaptions(meta), ["nurse_id", "shift_pattern", "skill_count"]);
});

test("buildCaptionResolver matches canonical columns to captions and never requests a forbidden column", () => {
  const resolver = buildCaptionResolver(
    ["patient_id", "acuity_level", "mean_skill_match_pct"],
    ["Patient Id", "Acuity Level", "Mean Skill Match Pct"],
  );
  assert.equal(resolver.get("patient_id"), "Patient Id");
  assert.equal(resolver.get("acuity_level"), "Acuity Level");
  assert.equal(resolver.has("mean_skill_match_pct"), false, "forbidden column is never requested");
});

test("buildCaptionResolver falls back to canonical names when metadata is empty", () => {
  const resolver = buildCaptionResolver(["skill_id", "skill_name"], []);
  assert.equal(resolver.get("skill_id"), "skill_id");
  assert.equal(resolver.get("skill_name"), "skill_name");
});

test("resolveDatasourceMap reads explicit override then env JSON", () => {
  assert.deepEqual(resolveDatasourceMap({ patients: "LU1" }), { patients: "LU1" });
  const prev = process.env.TRIAGE_MCP_DATASOURCES;
  process.env.TRIAGE_MCP_DATASOURCES = '{"nurses":"LU9"}';
  try {
    assert.deepEqual(resolveDatasourceMap(), { nurses: "LU9" });
  } finally {
    if (prev === undefined) delete process.env.TRIAGE_MCP_DATASOURCES;
    else process.env.TRIAGE_MCP_DATASOURCES = prev;
  }
  // bad JSON → {}
  process.env.TRIAGE_MCP_DATASOURCES = "{oops";
  try {
    assert.deepEqual(resolveDatasourceMap(), {});
  } finally {
    if (prev === undefined) delete process.env.TRIAGE_MCP_DATASOURCES;
    else process.env.TRIAGE_MCP_DATASOURCES = prev;
  }
});

// ── loadTablesFromMcp: parity with the CSV backend's shape ──────────────────────
test("loadTablesFromMcp returns canonical, all-string rows and strips the forbidden column", async () => {
  const luid = "LU_PATIENTS";
  const { callTool } = makeMockMcp({
    [luid]: [
      // Note: server also carries mean_skill_match_pct; it must NOT survive.
      { patient_id: "PT1", acuity_level: "Critical", adverse_outcome: 1, mean_skill_match_pct: 80.0, data_classification: "SYNTHETIC" },
      { patient_id: "PT2", acuity_level: "Low", adverse_outcome: 0, mean_skill_match_pct: 40.0, data_classification: "SYNTHETIC" },
    ],
  });
  const tables = await loadTablesFromMcp({ datasources: { patients: luid }, callTool });

  // every canonical table key is present, even unpublished ones
  assert.ok(Array.isArray(tables.nurses) && tables.nurses.length === 0);

  assert.equal(tables.patients.length, 2);
  const r = tables.patients[0];
  assert.equal(r.patient_id, "PT1");
  assert.equal(r.acuity_level, "Critical");
  assert.equal(typeof r.adverse_outcome, "string", "values are stringified like the CSV backend");
  assert.equal(r.adverse_outcome, "1");
  assert.ok(!("mean_skill_match_pct" in r), "forbidden validation-aid column stripped on read");
  assert.ok(FORBIDDEN_COLUMNS.has("mean_skill_match_pct"));
});

// ── the payoff: tools run backend-agnostically over MCP-backed tables ───────────
test("makeMcpDispatchTool reproduces a GROUND_TRUTH magnitude via the unchanged tools", async () => {
  // Two AI rows (skill 80, 70 → mean 75.0) and one Manual row (skill 30 → 30.0).
  // This is the same discovery path the CSV eval uses; only the backend differs.
  const luid = "LU_ASSIGN";
  const { callTool } = makeMockMcp({
    [luid]: [
      { assignment_id: "A1", patient_id: "PT1", nurse_id: "RN1", skill_match_pct: 80, assignment_method: "AI-Recommended", data_classification: "SYNTHETIC" },
      { assignment_id: "A2", patient_id: "PT2", nurse_id: "RN2", skill_match_pct: 70, assignment_method: "AI-Recommended", data_classification: "SYNTHETIC" },
      { assignment_id: "A3", patient_id: "PT3", nurse_id: "RN3", skill_match_pct: 30, assignment_method: "Manual", data_classification: "SYNTHETIC" },
    ],
  });
  const dispatch = makeMcpDispatchTool({ datasources: { assignments: luid }, callTool });

  const out = await dispatch("triage_query", {
    table: "assignments",
    group_by: ["assignment_method"],
    measures: [{ agg: "mean", field: "skill_match_pct" }],
  });
  const byMethod = Object.fromEntries(out.rows.map((r) => [r.assignment_method, r.mean_skill_match_pct]));
  assert.equal(byMethod["AI-Recommended"], 75.0);
  assert.equal(byMethod["Manual"], 30.0);
});

test("loadTablesFromMcp fetches tables sequentially (single shared MCP session)", async () => {
  // The MCP server signs into Tableau with ONE PAT under http transport; concurrent
  // signins terminate each other, so overlapping table fetches drop rows for all but
  // the race-winner (observed live). Guard: no two fetchTable round-trips may overlap.
  let inFlight = 0;
  let maxInFlight = 0;
  const luids = { patients: "LU_P", nurses: "LU_N", assignments: "LU_A" };
  const callTool = async (name) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1)); // force interleaving if any exists
    inFlight -= 1;
    if (name === "get-datasource-metadata") return { text: JSON.stringify({ fieldGroups: [{ fields: [{ name: "x" }] }] }) };
    return { text: JSON.stringify({ data: [{ x: "1" }] }) };
  };
  await loadTablesFromMcp({ datasources: luids, callTool });
  assert.equal(maxInFlight, 1, "table fetches must not overlap on the shared MCP session");
});

test("makeMcpDispatchTool fetches tables only once across multiple tool calls", async () => {
  const luid = "LU_ASSIGN";
  const { callTool, calls } = makeMockMcp({
    [luid]: [
      { assignment_id: "A1", patient_id: "PT1", nurse_id: "RN1", skill_match_pct: 80, assignment_method: "AI-Recommended" },
    ],
  });
  const dispatch = makeMcpDispatchTool({ datasources: { assignments: luid }, callTool });
  await dispatch("triage_query", { table: "assignments", measures: [{ agg: "count" }] });
  const queriesAfterFirst = calls.filter((c) => c.name === "query-datasource").length;
  await dispatch("triage_query", { table: "assignments", measures: [{ agg: "count" }] });
  const queriesAfterSecond = calls.filter((c) => c.name === "query-datasource").length;
  assert.equal(queriesAfterFirst, queriesAfterSecond, "second tool call reuses cached tables");
});
