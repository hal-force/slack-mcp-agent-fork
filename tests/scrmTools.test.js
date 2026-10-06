const { test } = require("node:test");
const assert = require("node:assert/strict");

const { loadTables } = require("../src/agents/scrmData");
const {
  runQuery,
  runCorrelation,
  runSupplierProfile,
  ssConcentratedMap,
  latestSnapshotDate,
  MAX_QUERY_LIMIT,
} = require("../src/agents/scrmTools");

// These tests run the SCRM tools against the REAL bundled fixture (demo-data/scrm) and
// assert they reproduce the planted-effect magnitudes — i.e. that a specialist reasoning
// through the tools CAN recover the effects. Expected magnitudes are the public,
// generator-validated numbers (demo-data/scrm/validate.js), not secret answer-key material.
const T = loadTables();

const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const rowFor = (res, pred) => res.rows.find(pred);

test("fixture loads with the expected row counts and no composite_risk_pct", () => {
  assert.equal(T.risk_snapshots.length, 5040);
  assert.equal(T.suppliers.length, 40);
  assert.equal(T.risk_registry.length, 7);
  assert.equal(T.components.length, 116);
  assert.equal(T.contracts.length, 93);
  assert.equal(T.findings.length, 100);
  // FORBIDDEN column is stripped from the suppliers table.
  assert.ok(!("composite_risk_pct" in (T.suppliers[0] || {})), "composite_risk_pct must be absent");
});

test("latest snapshot month is 2026-08-31", () => {
  assert.equal(latestSnapshotDate(T), "2026-08-31");
});

test("E1: FOCI suppliers carry higher CYBER risk (70.1 vs 30.8) in the latest month", () => {
  const res = runQuery(
    {
      table: "risk_snapshots",
      derive: ["is_latest_month"],
      filters: [
        { field: "is_latest_month", op: "eq", value: "yes" },
        { field: "risk_category", op: "eq", value: "CYBER" },
      ],
      group_by: ["foci_flag"],
      measures: [{ agg: "mean", field: "risk_score" }, { agg: "count" }],
    },
    T,
  );
  const foci = rowFor(res, (r) => r.foci_flag === "true");
  const non = rowFor(res, (r) => r.foci_flag === "false");
  assert.ok(near(foci.mean_risk_score, 70.1), `foci cyber ${foci.mean_risk_score} ≈ 70.1`);
  assert.ok(near(non.mean_risk_score, 30.8), `non-foci cyber ${non.mean_risk_score} ≈ 30.8`);
  assert.equal(foci.count, 12);
  assert.equal(non.count, 28);
});

test("E1: FOCI suppliers carry higher PROHIBITED_SRC risk (66.4 vs 15.8)", () => {
  const res = runQuery(
    {
      table: "risk_snapshots",
      derive: ["is_latest_month"],
      filters: [
        { field: "is_latest_month", op: "eq", value: "yes" },
        { field: "risk_category", op: "eq", value: "PROHIBITED_SRC" },
      ],
      group_by: ["foci_flag"],
      measures: [{ agg: "mean", field: "risk_score" }],
    },
    T,
  );
  assert.ok(near(rowFor(res, (r) => r.foci_flag === "true").mean_risk_score, 66.4));
  assert.ok(near(rowFor(res, (r) => r.foci_flag === "false").mean_risk_score, 15.8));
});

test("E1: the FOCI→CYBER gap holds within sector (9 shared sectors, all FOCI-higher)", () => {
  const res = runQuery(
    {
      table: "risk_snapshots",
      derive: ["is_latest_month"],
      filters: [
        { field: "is_latest_month", op: "eq", value: "yes" },
        { field: "risk_category", op: "eq", value: "CYBER" },
      ],
      group_by: ["sector", "foci_flag"],
      measures: [{ agg: "mean", field: "risk_score" }],
    },
    T,
  );
  const bySector = new Map();
  for (const r of res.rows) {
    if (!bySector.has(r.sector)) bySector.set(r.sector, {});
    bySector.get(r.sector)[r.foci_flag] = r.mean_risk_score;
  }
  let shared = 0;
  let fociHigher = 0;
  for (const [, v] of bySector) {
    if (v.true != null && v.false != null) {
      shared++;
      if (v.true > v.false) fociHigher++;
    }
  }
  assert.equal(shared, 9, "9 sectors contain both FOCI and non-FOCI suppliers");
  assert.equal(fociHigher, 9, "FOCI cohort is higher in every shared sector");
});

test("E2: single-source concentration raises DELIVERY only for Mission-Critical (interaction)", () => {
  const mc = runQuery(
    {
      table: "risk_snapshots",
      derive: ["is_latest_month", "ss_concentrated"],
      filters: [
        { field: "is_latest_month", op: "eq", value: "yes" },
        { field: "risk_category", op: "eq", value: "DELIVERY" },
        { field: "criticality", op: "eq", value: "Mission-Critical" },
      ],
      group_by: ["ss_concentrated"],
      measures: [{ agg: "mean", field: "risk_score" }, { agg: "count" }],
    },
    T,
  );
  const mcYes = rowFor(mc, (r) => r.ss_concentrated === "yes");
  const mcNo = rowFor(mc, (r) => r.ss_concentrated === "no");
  assert.ok(near(mcYes.mean_risk_score, 67.6), `MC concentrated ${mcYes.mean_risk_score} ≈ 67.6`);
  assert.ok(near(mcNo.mean_risk_score, 31.7), `MC not ${mcNo.mean_risk_score} ≈ 31.7`);
  assert.equal(mcYes.count, 8);
  assert.equal(mcNo.count, 2);

  const nonMc = runQuery(
    {
      table: "risk_snapshots",
      derive: ["is_latest_month", "ss_concentrated"],
      filters: [
        { field: "is_latest_month", op: "eq", value: "yes" },
        { field: "risk_category", op: "eq", value: "DELIVERY" },
        { field: "criticality", op: "ne", value: "Mission-Critical" },
      ],
      group_by: ["ss_concentrated"],
      measures: [{ agg: "mean", field: "risk_score" }, { agg: "count" }],
    },
    T,
  );
  const nmcYes = rowFor(nonMc, (r) => r.ss_concentrated === "yes");
  const nmcNo = rowFor(nonMc, (r) => r.ss_concentrated === "no");
  assert.ok(near(nmcYes.mean_risk_score, 38.9), `non-MC concentrated ${nmcYes.mean_risk_score} ≈ 38.9`);
  assert.ok(near(nmcNo.mean_risk_score, 29.7), `non-MC not ${nmcNo.mean_risk_score} ≈ 29.7`);
  // The interaction: MC gap (35.9) is far larger than the non-MC gap (9.2).
  const mcGap = mcYes.mean_risk_score - mcNo.mean_risk_score;
  const nonMcGap = nmcYes.mean_risk_score - nmcNo.mean_risk_score;
  assert.ok(mcGap > 25 && nonMcGap < 15, `MC gap ${mcGap} >> non-MC gap ${nonMcGap}`);
});

test("ss_concentrated flags 14 suppliers (8 Mission-Critical + 6 other)", () => {
  const m = ssConcentratedMap(T);
  const flagged = [...m.values()].filter(Boolean).length;
  assert.equal(flagged, 14);
});

test("E3: FINANCIAL correlates with DELIVERY (r≈0.76 over 40 suppliers)", () => {
  const res = runCorrelation(
    { x: { source: "kri_score", risk_category: "FINANCIAL" }, y: { source: "kri_score", risk_category: "DELIVERY" } },
    T,
  );
  assert.equal(res.n, 40);
  assert.ok(res.r >= 0.6 && res.r <= 0.9, `r=${res.r} should be ≈0.76`);
});

test("traps: established_year and contract_count do NOT correlate with overall risk", () => {
  const est = runCorrelation(
    { x: { source: "supplier_attr", field: "established_year" }, y: { source: "overall_risk" } },
    T,
  );
  const cc = runCorrelation(
    { x: { source: "supplier_attr", field: "contract_count" }, y: { source: "overall_risk" } },
    T,
  );
  assert.equal(est.n, 40);
  assert.ok(Math.abs(est.r) < 0.35, `established_year r=${est.r} should be ~null`);
  assert.ok(Math.abs(cc.r) < 0.35, `contract_count r=${cc.r} should be ~null`);
});

test("composite_risk_pct is unavailable to the correlation tool (circular roll-up)", () => {
  const res = runCorrelation(
    { x: { source: "supplier_attr", field: "composite_risk_pct" }, y: { source: "overall_risk" } },
    T,
  );
  assert.ok(res.error && /composite_risk_pct|unavailable|not a numeric/i.test(res.error), `expected an error, got ${JSON.stringify(res)}`);
});

test("scrm_supplier_profile returns the latest-month KRI posture + drill-down for SUP-001", () => {
  const p = runSupplierProfile({ supplier_key: "SUP-001" }, T);
  assert.equal(p.supplier.supplier_name, "Meridian Microelectronics");
  assert.equal(p.supplier.foci_flag, "true");
  assert.equal(p.latest_month, "2026-08-31");
  assert.equal(p.kris.length, 7, "all 7 KRIs for the latest month");
  assert.ok(p.open_findings.length >= 1, "has at least one open finding");
  // composite_risk_pct never leaks into the profile.
  assert.ok(!("composite_risk_pct" in p.supplier));
});

test("scrm_supplier_profile resolves by name and reports ss_concentrated", () => {
  const p = runSupplierProfile({ supplier_name: "Meridian Microelectronics" }, T);
  assert.equal(p.supplier.supplier_key, "SUP-001");
  assert.equal(typeof p.ss_concentrated, "boolean");
});

test("runQuery rejects an unknown table", () => {
  const res = runQuery({ table: "nope" }, T);
  assert.ok(res.error && /unknown table/.test(res.error));
});

// ── input handling: parity across backends, no silent pass-throughs ──────────

// A minimal table set in each backend's boolean rendering: the CSV fixture mixes
// "TRUE"/"true", the Tableau backend stringifies VDS booleans as "true".
const boolTables = (t, f) => ({
  components: [
    { component_key: "C1", supplier_key: "S1", single_source_flag: t },
    { component_key: "C2", supplier_key: "S2", single_source_flag: f },
    { component_key: "C3", supplier_key: "S3", single_source_flag: t },
  ],
});

test("boolean filters and groups behave identically for CSV TRUE and VDS true", () => {
  for (const [t, f] of [["TRUE", "FALSE"], ["true", "false"]]) {
    for (const value of [true, "true", "TRUE"]) {
      const res = runQuery(
        { table: "components", filters: [{ field: "single_source_flag", op: "eq", value }] },
        boolTables(t, f),
      );
      assert.equal(res.rows[0].count, 2, `backend ${t}, filter value ${JSON.stringify(value)}`);
    }
    const grouped = runQuery({ table: "components", group_by: ["single_source_flag"] }, boolTables(t, f));
    assert.deepEqual(grouped.rows.map((r) => r.single_source_flag), ["false", "true"]);
  }
});

test("runQuery rejects an unknown filter op instead of ignoring the filter", () => {
  const res = runQuery(
    { table: "components", filters: [{ field: "single_source_flag", op: "contains", value: "t" }] },
    boolTables("true", "false"),
  );
  assert.match(res.error, /unsupported filter op "contains"/);
});

test("runQuery rejects columns the table doesn't have (typo or missing from the datasource)", () => {
  const res = runQuery({ table: "components", group_by: ["single_sorce_flag"] }, boolTables("true", "false"));
  assert.match(res.error, /unknown column\(s\) "single_sorce_flag" on components/);
});

test("rate over a true/false flag is a percentage, not null", () => {
  const res = runQuery(
    { table: "risk_snapshots", derive: ["is_latest_month"], filters: [{ field: "is_latest_month", op: "eq", value: "yes" }], measures: [{ agg: "rate", field: "alert_flag" }] },
    T,
  );
  const rate = res.rows[0].rate_alert_flag;
  assert.equal(typeof rate, "number");
  assert.ok(rate > 0 && rate < 100, `rate=${rate}`);
});

test("scrm_query caps returned groups at MAX_QUERY_LIMIT and flags truncation", () => {
  const res = runQuery({ table: "risk_snapshots", group_by: ["supplier_key", "risk_category", "period_month"], limit: 100000 }, T);
  assert.equal(res.groups, 5040);
  assert.equal(res.rows.length, MAX_QUERY_LIMIT);
  assert.equal(res.truncated, true);
});
