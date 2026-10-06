#!/usr/bin/env node
/**
 * Validate the PLANTED effects in the synthetic ARMOR fixture and print the
 * realized magnitudes. Mirrors demo-data/scrm/validate.js: it reads the
 * emitted CSVs (agent-facing data only — no answer key), independently
 * RECOMPUTES the capacity model from the raw personnel/credentials/readiness
 * tables (never trusting a baked column), and confirms the planted signals
 * are present and the decoys are null. The `measured_effects` JSON it prints
 * is copied verbatim into tests/eval/armor/manifest.json + GROUND_TRUTH.md so
 * scoring is numerical.
 *
 * Run: node demo-data/armor/validate.js
 * Exit code 0 = all effects/checks within tolerance; 1 = drift (regenerate).
 */

"use strict";
const fs = require("fs");
const path = require("path");

const DIR = __dirname;

// -- tiny CSV parser (handles quoted cells with commas/quotes) --
function parseCsv(file) {
  const text = fs.readFileSync(path.join(DIR, file), "utf8");
  const rows = [];
  let field = "", row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j]])));
}

const num = (x) => Number(x);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function pearson(xs, ys) {
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

// -- load --
const facilities = parseCsv("armor_facilities.csv");
const bedCapacity = parseCsv("armor_bed_capacity.csv");
const billets = parseCsv("armor_billets.csv");
const personnel = parseCsv("armor_personnel.csv");
const credentials = parseCsv("armor_credentials.csv");
const readiness = parseCsv("armor_readiness.csv");
const snaps = parseCsv("armor_readiness_snapshots.csv");
const model = parseCsv("armor_staffing_model.csv");

const LATEST = snaps.reduce((m, r) => (r.period_month > m ? r.period_month : m), "");
const latestSnaps = snaps.filter((r) => r.period_month === LATEST);

const modelByUnit = Object.fromEntries(model.map((m) => [m.unit_type, m]));
const specialtyToUnit = Object.fromEntries(model.map((m) => [m.required_specialty, m.unit_type]));
const privilegeToUnit = Object.fromEntries(model.map((m) => [m.required_privilege, m.unit_type]));

// -- independently recompute available_qualified_staff + staffed_beds from
//    the raw personnel/credentials/readiness/bed_capacity tables, per the
//    design's algorithm. Never reads a baked "staffed_beds" while doing this.
const credByPerson = Object.fromEntries(credentials.map((c) => [c.person_id, c]));
const readyByPerson = Object.fromEntries(readiness.map((r) => [r.person_id, r]));
const bedByMtfUnit = {};
for (const b of bedCapacity) (bedByMtfUnit[b.mtf_id] ||= {})[b.unit_type] = b;

const qualifiedByMtfUnit = {}; // qualifiedByMtfUnit[mtf][unit] = count
const filledByMtfUnit = {};
const authorizedByMtfUnit = {};
for (const b of billets) {
  authorizedByMtfUnit[b.mtf_id] ||= {};
  authorizedByMtfUnit[b.mtf_id][b.unit_type] = (authorizedByMtfUnit[b.mtf_id][b.unit_type] || 0) + num(b.authorized);
}
for (const p of personnel) {
  const unit = specialtyToUnit[p.specialty];
  if (!unit) continue;
  const req = modelByUnit[unit];
  const cred = credByPerson[p.person_id];
  const rdy = readyByPerson[p.person_id];
  filledByMtfUnit[p.mtf_id] ||= {};
  filledByMtfUnit[p.mtf_id][unit] = (filledByMtfUnit[p.mtf_id][unit] || 0) + 1;
  const qualifies =
    privilegeToUnit[cred.privilege] === unit &&
    cred.privilege_status === "active" &&
    rdy.medical_clearance === "fully" &&
    p.availability_status === "on_station";
  if (qualifies) {
    qualifiedByMtfUnit[p.mtf_id] ||= {};
    qualifiedByMtfUnit[p.mtf_id][unit] = (qualifiedByMtfUnit[p.mtf_id][unit] || 0) + 1;
  }
}

const mtfIds = facilities.map((f) => f.mtf_id);
const unitKeys = model.map((m) => m.unit_type);
function recomputeStaffed(mtf, unit) {
  const qualified = (qualifiedByMtfUnit[mtf] && qualifiedByMtfUnit[mtf][unit]) || 0;
  const physical = num(bedByMtfUnit[mtf][unit].physical_beds);
  const bps = num(modelByUnit[unit].beds_per_staff);
  return Math.min(physical, Math.floor(qualified * bps));
}

// ================================================================ INTEGRITY
const integrity = [];
const iok = (name, cond) => integrity.push({ name, pass: !!cond });

iok("row counts: bed_capacity = mtf x unit_type", bedCapacity.length === mtfIds.length * unitKeys.length);
iok("row counts: readiness_snapshots = mtf x unit_type x months", snaps.length % (mtfIds.length * unitKeys.length) === 0);
iok("row counts: personnel = credentials = readiness", personnel.length === credentials.length && credentials.length === readiness.length);

let everySnapshotHasCapacity = true;
for (const s of latestSnaps) {
  if (!bedByMtfUnit[s.mtf_id] || !bedByMtfUnit[s.mtf_id][s.unit_type]) everySnapshotHasCapacity = false;
}
iok("every latest snapshot mtf x unit exists in bed_capacity", everySnapshotHasCapacity);

let staffedNeverExceedsPhysical = true;
for (const s of snaps) {
  if (num(s.staffed_beds) > num(s.physical_beds)) staffedNeverExceedsPhysical = false;
}
iok("staffed_beds <= physical_beds (all months, all mtf x unit)", staffedNeverExceedsPhysical);

let latestMatchesModel = true;
const mismatches = [];
for (const s of latestSnaps) {
  const recomputed = recomputeStaffed(s.mtf_id, s.unit_type);
  if (recomputed !== num(s.staffed_beds)) {
    latestMatchesModel = false;
    mismatches.push({ mtf: s.mtf_id, unit: s.unit_type, snapshot: num(s.staffed_beds), recomputed });
  }
}
iok("latest-month staffed_beds == capacity-model recomputation (all 60 mtf x unit)", latestMatchesModel);
if (!latestMatchesModel) console.error("MISMATCHES:", JSON.stringify(mismatches, null, 2));

// ================================================================ E1: fill rate + qualified erosion (ICU vs Med-Surg)
function fillAndQualified(unit) {
  let authorized = 0, filled = 0, qualified = 0;
  for (const mtf of mtfIds) {
    authorized += (authorizedByMtfUnit[mtf] && authorizedByMtfUnit[mtf][unit]) || 0;
    filled += (filledByMtfUnit[mtf] && filledByMtfUnit[mtf][unit]) || 0;
    qualified += (qualifiedByMtfUnit[mtf] && qualifiedByMtfUnit[mtf][unit]) || 0;
  }
  return {
    authorized, filled, qualified,
    fill_rate: r1((100 * filled) / authorized),
    qualified_rate_of_authorized: r1((100 * qualified) / authorized),
    qualified_rate_of_filled: r1((100 * qualified) / filled),
    erosion_pct_of_filled: r1((100 * (filled - qualified)) / filled),
  };
}
const e1 = {
  icu: fillAndQualified("ICU"),
  med_surg: fillAndQualified("Med-Surg"),
};
e1.fill_gap_pct_pts = r1(e1.med_surg.fill_rate - e1.icu.fill_rate);

// structural check: does the ICU-fill-below-Med-Surg pattern hold across
// individual MTFs too, not just in aggregate?
let mtfsWithBoth = 0, mtfsIcuLowerFill = 0;
for (const mtf of mtfIds) {
  const icuAuth = (authorizedByMtfUnit[mtf] && authorizedByMtfUnit[mtf]["ICU"]) || 0;
  const msAuth = (authorizedByMtfUnit[mtf] && authorizedByMtfUnit[mtf]["Med-Surg"]) || 0;
  if (icuAuth && msAuth) {
    mtfsWithBoth++;
    const icuFill = ((filledByMtfUnit[mtf] && filledByMtfUnit[mtf]["ICU"]) || 0) / icuAuth;
    const msFill = ((filledByMtfUnit[mtf] && filledByMtfUnit[mtf]["Med-Surg"]) || 0) / msAuth;
    if (icuFill < msFill) mtfsIcuLowerFill++;
  }
}
e1.mtfs_with_both = mtfsWithBoth;
e1.mtfs_icu_fill_below_medsurg = mtfsIcuLowerFill;

// ================================================================ E2: burn-center vs deep-bench ICU tipping contrast
const BURN_CENTER_MTF = facilities.find((f) => f.sole_regional_role === "Burn").mtf_id;
// deep bench = the non-burn-center MTF with the largest ICU slack above threshold
const icuThreshold = num(modelByUnit.ICU.readiness_threshold_beds);
const icuBedsPerStaff = num(modelByUnit.ICU.beds_per_staff);
const icuSlack = {};
for (const mtf of mtfIds) {
  const s = latestSnaps.find((r) => r.mtf_id === mtf && r.unit_type === "ICU");
  icuSlack[mtf] = num(s.staffed_beds) - icuThreshold;
}
const deepBenchCandidates = mtfIds.filter((m) => m !== BURN_CENTER_MTF);
const DEEP_BENCH_MTF = deepBenchCandidates.reduce((best, m) => (icuSlack[m] > icuSlack[best] ? m : best), deepBenchCandidates[0]);

const REASSIGN_N = 5; // matches the proposed TSK-0001 tasking
const delta = REASSIGN_N * icuBedsPerStaff; // 10 beds

function whatIf(mtf) {
  const s = latestSnaps.find((r) => r.mtf_id === mtf && r.unit_type === "ICU");
  const staffedNow = num(s.staffed_beds);
  const staffedAfter = Math.max(0, staffedNow - delta);
  const ragNow = staffedNow < icuThreshold ? "Red" : staffedNow < icuThreshold * 1.1 ? "Yellow" : "Green";
  const ragAfter = staffedAfter < icuThreshold ? "Red" : staffedAfter < icuThreshold * 1.1 ? "Yellow" : "Green";
  return { mtf, staffed_now: staffedNow, staffed_after: staffedAfter, threshold: icuThreshold, rag_now: ragNow, rag_after: ragAfter, tips_red: ragAfter === "Red" && ragNow !== "Red" };
}
const e2 = {
  burn_center_mtf: BURN_CENTER_MTF,
  deep_bench_mtf: DEEP_BENCH_MTF,
  reassign_n: REASSIGN_N,
  delta_beds: delta,
  burn_center: whatIf(BURN_CENTER_MTF),
  deep_bench: whatIf(DEEP_BENCH_MTF),
};

// ================================================================ E3: facility size does not predict readiness (staff is the constraint)
// Different unit types have structurally different fill/erosion targets (E1)
// and typical physical scale (an ICU and a Med-Surg ward are not the same
// size), so a raw pooled correlation across unit types would be confounded
// by *which* unit type a row belongs to, not by facility size. We control
// for that the standard way: demean each variable within its unit_type
// (a fixed-effects / within-group transform) before pooling across all
// mtf x unit rows, so the test is "within a given unit type, does a bigger
// MTF's version of that unit run relatively more staffed?"
function withinUnitTypeResiduals(rows, valueKey) {
  const byUnit = {};
  for (const r of rows) (byUnit[r.unit_type] ||= []).push(r);
  const out = [];
  for (const unit of Object.keys(byUnit)) {
    const grp = byUnit[unit];
    const m = mean(grp.map((r) => r[valueKey]));
    for (const r of grp) out.push(r[valueKey] - m);
  }
  return out;
}
const sizeReadinessRows = latestSnaps.map((s) => {
  const physical = num(s.physical_beds);
  const staffed = num(s.staffed_beds);
  const sqft = num(bedByMtfUnit[s.mtf_id][s.unit_type].square_footage);
  const authorized = (authorizedByMtfUnit[s.mtf_id] && authorizedByMtfUnit[s.mtf_id][s.unit_type]) || 0;
  return { unit_type: s.unit_type, physical, sqft, authorized, ratio: staffed / physical };
});
const e3 = {
  r_physical_beds_vs_staffed_ratio: r2(pearson(withinUnitTypeResiduals(sizeReadinessRows, "physical"), withinUnitTypeResiduals(sizeReadinessRows, "ratio"))),
  r_square_footage_vs_staffed_ratio: r2(pearson(withinUnitTypeResiduals(sizeReadinessRows, "sqft"), withinUnitTypeResiduals(sizeReadinessRows, "ratio"))),
};

// -- secondary decoy: high billet AUTHORIZATION != readiness (same within-unit-type control) --
const traps = {
  r_authorized_billets_vs_staffed_ratio: r2(pearson(withinUnitTypeResiduals(sizeReadinessRows, "authorized"), withinUnitTypeResiduals(sizeReadinessRows, "ratio"))),
};

const measured = {
  latest_month: LATEST,
  n_mtfs: mtfIds.length,
  n_unit_types: unitKeys.length,
  effect1_fill_and_qualified_erosion: e1,
  effect2_burn_vs_deepbench_whatif: e2,
  effect3_size_vs_readiness_null: e3,
  traps_should_be_null: traps,
};
console.log(JSON.stringify(measured, null, 2));

// ================================================================ assertions
const checks = [...integrity];
const ok = (name, cond) => checks.push({ name, pass: !!cond });

ok("E1 ICU fill rate in [73,83]%", e1.icu.fill_rate >= 73 && e1.icu.fill_rate <= 83);
ok("E1 Med-Surg fill rate in [93,99]%", e1.med_surg.fill_rate >= 93 && e1.med_surg.fill_rate <= 99);
ok("E1 fill gap (Med-Surg - ICU) >= 12 pts", e1.fill_gap_pct_pts >= 12);
ok("E1 ICU erosion among filled in [8,20]%", e1.icu.erosion_pct_of_filled >= 8 && e1.icu.erosion_pct_of_filled <= 20);
ok("E1 Med-Surg erosion among filled < 8%", e1.med_surg.erosion_pct_of_filled < 8);
ok("E1 net ICU qualified-rate-of-authorized well below fill rate (gap >= 10 pts)", e1.icu.fill_rate - e1.icu.qualified_rate_of_authorized >= 10);
ok("E1 structural: holds at >=70% of MTFs with both units", mtfsWithBoth === 0 || mtfsIcuLowerFill / mtfsWithBoth >= 0.7);

ok("E2 burn-center ICU currently NOT Red", e2.burn_center.rag_now !== "Red");
ok("E2 burn-center ICU tips to Red after -10 beds", e2.burn_center.tips_red === true);
ok("E2 deep-bench ICU stays Green after -10 beds", e2.deep_bench.rag_after === "Green");
ok("E2 burn-center slack < deep-bench slack (interaction)", (e2.burn_center.staffed_now - e2.burn_center.threshold) < (e2.deep_bench.staffed_now - e2.deep_bench.threshold));

ok("E3 |r| physical_beds vs staffed ratio < 0.25", Math.abs(e3.r_physical_beds_vs_staffed_ratio) < 0.25);
ok("E3 |r| square_footage vs staffed ratio < 0.25", Math.abs(e3.r_square_footage_vs_staffed_ratio) < 0.25);
ok("TRAP |r| authorized billets vs staffed ratio < 0.4", Math.abs(traps.r_authorized_billets_vs_staffed_ratio) < 0.4);

console.error("\nplanted-effect checks:");
let allPass = true;
for (const c of checks) { console.error(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}`); if (!c.pass) allPass = false; }
console.error(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED — inspect magnitudes / adjust generator");
process.exit(allPass ? 0 : 1);
