#!/usr/bin/env node
/**
 * Validate the PLANTED effects in the synthetic SCRM fixture and print the
 * realized magnitudes. Mirrors the triage fixture's validate step: it reads the
 * emitted CSVs (agent-facing data only — no answer key), recomputes the effects
 * from the LATEST month, and confirms the planted signals are present and the
 * decoys are null. The `measured_effects` JSON it prints is copied verbatim into
 * tests/eval/scrm/manifest.json + GROUND_TRUTH.md so scoring is numerical.
 *
 * Run: node demo-data/scrm/validate.js
 * Exit code 0 = all effects/traps within tolerance; 1 = drift (regenerate).
 */

"use strict";
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const CONCENTRATED_REGIONS = ["China", "Taiwan"];

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
const snaps = parseCsv("scrm_risk_snapshots.csv");
const suppliers = parseCsv("scrm_suppliers.csv");
const components = parseCsv("scrm_components.csv");

const LATEST = snaps.reduce((m, r) => (r.snapshot_date > m ? r.snapshot_date : m), "");
const latest = snaps.filter((r) => r.snapshot_date === LATEST);

// per-supplier latest score by KRI
const scoreBy = {}; // scoreBy[supKey][kri] = score
for (const r of latest) (scoreBy[r.supplier_key] ||= {})[r.risk_category] = num(r.risk_score);

// recompute ss_concentrated from components (>=2 single-source parts from a concentrated region)
const ssConc = {};
for (const s of suppliers) {
  const mine = components.filter((c) => c.supplier_key === s.supplier_key);
  ssConc[s.supplier_key] = mine.filter((c) => c.single_source_flag === "TRUE" && CONCENTRATED_REGIONS.includes(c.country_of_origin)).length >= 2;
}

const supBy = Object.fromEntries(suppliers.map((s) => [s.supplier_key, s]));
const foci = suppliers.filter((s) => s.foci_flag === "true");
const nonFoci = suppliers.filter((s) => s.foci_flag === "false");
const cyber = (list) => list.map((s) => scoreBy[s.supplier_key].CYBER);
const prohib = (list) => list.map((s) => scoreBy[s.supplier_key].PROHIBITED_SRC);
const delivery = (list) => list.map((s) => scoreBy[s.supplier_key].DELIVERY);

// -- Effect 1: FOCI -> CYBER & PROHIBITED_SRC (holds within sector) --
const e1 = {
  n_foci: foci.length, n_non_foci: nonFoci.length,
  cyber_foci: r1(mean(cyber(foci))), cyber_non_foci: r1(mean(cyber(nonFoci))),
  prohibited_foci: r1(mean(prohib(foci))), prohibited_non_foci: r1(mean(prohib(nonFoci))),
};
// within-sector directional check
const sectors = [...new Set(suppliers.map((s) => s.sector))];
let sectorsWithBoth = 0, sectorsFociHigher = 0;
for (const sec of sectors) {
  const f = foci.filter((s) => s.sector === sec), nf = nonFoci.filter((s) => s.sector === sec);
  if (f.length && nf.length) { sectorsWithBoth++; if (mean(cyber(f)) > mean(cyber(nf))) sectorsFociHigher++; }
}
e1.sectors_with_both = sectorsWithBoth;
e1.sectors_foci_cyber_higher = sectorsFociHigher;

// -- Effect 2: single-source concentration -> DELIVERY, ONLY for Mission-Critical --
const mc = suppliers.filter((s) => s.criticality === "Mission-Critical");
const nonMc = suppliers.filter((s) => s.criticality !== "Mission-Critical");
const mcConc = mc.filter((s) => ssConc[s.supplier_key]);
const mcNot = mc.filter((s) => !ssConc[s.supplier_key]);
const nmcConc = nonMc.filter((s) => ssConc[s.supplier_key]);
const nmcNot = nonMc.filter((s) => !ssConc[s.supplier_key]);
const e2 = {
  delivery_mc_ssconc: r1(mean(delivery(mcConc))), n_mc_ssconc: mcConc.length,
  delivery_mc_not: r1(mean(delivery(mcNot))), n_mc_not: mcNot.length,
  delivery_nonmc_ssconc: r1(mean(delivery(nmcConc))), n_nonmc_ssconc: nmcConc.length,
  delivery_nonmc_not: r1(mean(delivery(nmcNot))), n_nonmc_not: nmcNot.length,
};

// -- Effect 3: FINANCIAL correlates with DELIVERY (weaker, confounded) --
const finArr = suppliers.map((s) => scoreBy[s.supplier_key].FINANCIAL);
const delArr = suppliers.map((s) => scoreBy[s.supplier_key].DELIVERY);
const e3 = { r_financial_delivery: r2(pearson(finArr, delArr)) };

// -- Traps (must be ~null) --
const comp = suppliers.map((s) => num(s.composite_risk_pct));
const sb = suppliers.filter((s) => s.small_business === "true").map((s) => num(s.composite_risk_pct));
const nsb = suppliers.filter((s) => s.small_business === "false").map((s) => num(s.composite_risk_pct));
const traps = {
  composite_small_business: r1(mean(sb)),
  composite_not_small_business: r1(mean(nsb)),
  r_established_year_composite: r2(pearson(suppliers.map((s) => num(s.established_year)), comp)),
  r_contract_count_composite: r2(pearson(suppliers.map((s) => num(s.contract_count)), comp)),
};

const measured = {
  latest_month: LATEST,
  n_suppliers: suppliers.length,
  effect1_foci_cyber_prohibited: e1,
  effect2_ssconc_delivery_interaction: e2,
  effect3_financial_delivery: e3,
  traps_should_be_null: traps,
};
console.log(JSON.stringify(measured, null, 2));

// -- assertions --
const checks = [];
const ok = (name, cond) => checks.push({ name, pass: !!cond });
ok("E1 FOCI cyber >> non-FOCI (gap >= 15)", e1.cyber_foci - e1.cyber_non_foci >= 15);
ok("E1 FOCI prohibited >> non-FOCI (gap >= 20)", e1.prohibited_foci - e1.prohibited_non_foci >= 20);
ok("E1 holds within-sector (>=70% of shared sectors)", sectorsWithBoth === 0 || sectorsFociHigher / sectorsWithBoth >= 0.7);
ok("E2 MC ss-conc delivery >> MC not (gap >= 15)", e2.delivery_mc_ssconc - e2.delivery_mc_not >= 15);
ok("E2 interaction: non-MC gap small (< 12)", Math.abs(e2.delivery_nonmc_ssconc - e2.delivery_nonmc_not) < 12);
ok("E3 financial~delivery positive (r >= 0.2)", e3.r_financial_delivery >= 0.2);
ok("TRAP small-business ~ null (|gap| < 8)", Math.abs(traps.composite_small_business - traps.composite_not_small_business) < 8);
ok("TRAP established_year ~ null (|r| < 0.2)", Math.abs(traps.r_established_year_composite) < 0.2);
ok("TRAP contract_count ~ null (|r| < 0.2)", Math.abs(traps.r_contract_count_composite) < 0.2);

console.error("\nplanted-effect checks:");
let allPass = true;
for (const c of checks) { console.error(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}`); if (!c.pass) allPass = false; }
console.error(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED — inspect magnitudes / adjust generator");
process.exit(allPass ? 0 : 1);
