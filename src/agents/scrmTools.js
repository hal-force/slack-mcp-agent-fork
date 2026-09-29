/**
 * scrmTools — the tool surface the SCRM (supply-chain-risk) specialist calls.
 *
 * Three tools, in Bedrock Converse / Cohere `{ name, description, inputSchema }`
 * shape (the provider-neutral tool spec both generateWithBedrock and
 * generateWithCohere accept), dispatched by dispatchScrmTool(name, input):
 *
 *   1. scrm_query            — grouped aggregation over ONE table (the agent's
 *                              primary analysis primitive: compare groups, compute
 *                              counts/rates/means). Mirrors a VizQL query-datasource
 *                              call. Supports derived columns for the cross-table
 *                              signals a single passthrough table can't express.
 *   2. scrm_correlation      — Pearson r between two per-supplier numeric series
 *                              (KRI score, an honest overall-risk roll-up, or a
 *                              supplier attribute). The only way to characterize a
 *                              linear relationship (E3 financial↔delivery; the
 *                              established-year / contract-count rule-outs).
 *   3. scrm_supplier_profile — drill into ONE supplier: latest-month KRIs + RAG +
 *                              alerts, single-source/889 components, exposed
 *                              contracts, open findings (recommendation / triage).
 *
 * The tools carry NO knowledge of which group comparisons reveal a planted effect —
 * the specialist has to find them. They also refuse to surface the validation-aid
 * column (scrmData.FORBIDDEN_COLUMNS = composite_risk_pct): the honest way to gauge a
 * supplier's overall risk is to aggregate the snapshot KRI scores, not read a
 * precomputed roll-up.
 *
 * The SAME module runs against the local CSVs (scrmData) or the published Tableau
 * datasources (scrmMcpData) — the tool names/shapes and the specialist prompt do not
 * change between backends; only the `{ tables }` handed to dispatchScrmTool does.
 */

const { loadTables, num } = require("./scrmData");

const TABLE_NAMES = [
  "risk_snapshots",
  "suppliers",
  "risk_registry",
  "components",
  "contracts",
  "findings",
];

// Derived columns scrm_query can add before grouping. Each is computed honestly from
// the raw passthrough tables — the specialist could reconstruct them itself, but they
// are the cross-table joins that MUST NOT be done by fanning the tables together.
const DERIVE_NAMES = [
  "is_latest_month", // risk_snapshots: this row is in the most recent snapshot month
  "ss_concentrated", // supplier has >=2 single-source parts from a concentrated region
  "small_business", // supplier attribute, attached by supplier_key (for the null test)
  "established_year", // supplier attribute, attached by supplier_key (for the null test)
  "contract_count", // supplier attribute, attached by supplier_key (for the null test)
];

// The regions whose single-source parts define geographic concentration in this
// fixture. Matches demo-data/scrm/validate.js exactly so the tool reproduces the
// answer key.
const CONCENTRATED_REGIONS = new Set(["china", "taiwan"]);

// ── derived-column helpers ──────────────────────────────────────────────────

/** Latest snapshot month value (max snapshot_date) across the snapshots table. */
function latestSnapshotDate(tables) {
  let max = "";
  for (const r of tables.risk_snapshots || []) {
    const d = String(r.snapshot_date || "");
    if (d > max) max = d;
  }
  return max;
}

/**
 * supplier_key → true if the supplier has >=2 single-source components sourced from a
 * concentrated region (China/Taiwan). Case-insensitive on the flag so it works
 * whether the backend renders the boolean as CSV "TRUE" or VDS "true".
 */
function ssConcentratedMap(tables) {
  const counts = new Map();
  for (const c of tables.components || []) {
    const single = String(c.single_source_flag || "").trim().toLowerCase() === "true";
    const region = String(c.country_of_origin || "").trim().toLowerCase();
    if (single && CONCENTRATED_REGIONS.has(region)) {
      counts.set(c.supplier_key, (counts.get(c.supplier_key) || 0) + 1);
    }
  }
  const out = new Map();
  for (const s of tables.suppliers || []) {
    out.set(s.supplier_key, (counts.get(s.supplier_key) || 0) >= 2);
  }
  return out;
}

/** supplier_key → the suppliers-table row (for attribute passthrough). */
function suppliersByKey(tables) {
  const m = new Map();
  for (const s of tables.suppliers || []) m.set(s.supplier_key, s);
  return m;
}

/**
 * Apply requested derived columns to a copy of the rows.
 * @param {string} table
 * @param {Array<object>} rows
 * @param {string[]} derive
 * @param {object} tables  full table set (needed for cross-table derives)
 */
function applyDerives(table, rows, derive, tables) {
  if (!derive || derive.length === 0) return rows.map((r) => ({ ...r }));
  const want = new Set(derive);
  const latest = want.has("is_latest_month") ? latestSnapshotDate(tables) : null;
  const ssConc = want.has("ss_concentrated") ? ssConcentratedMap(tables) : null;
  const needSupplierAttr =
    want.has("small_business") || want.has("established_year") || want.has("contract_count");
  const supMap = needSupplierAttr ? suppliersByKey(tables) : null;

  return rows.map((r) => {
    const row = { ...r };
    if (latest != null && "snapshot_date" in r) {
      row.is_latest_month = String(r.snapshot_date || "") === latest ? "yes" : "no";
    }
    if (ssConc && r.supplier_key != null) {
      row.ss_concentrated = ssConc.get(r.supplier_key) ? "yes" : "no";
    }
    if (supMap && r.supplier_key != null) {
      const s = supMap.get(r.supplier_key);
      // Only attach when the row doesn't already carry the native column, so we never
      // clobber the suppliers table's own values.
      if (s) {
        if (want.has("small_business") && !("small_business" in r)) row.small_business = s.small_business;
        if (want.has("established_year") && !("established_year" in r)) row.established_year = s.established_year;
        if (want.has("contract_count") && !("contract_count" in r)) row.contract_count = s.contract_count;
      }
    }
    return row;
  });
}

// ── filtering ───────────────────────────────────────────────────────────────

function passesFilter(row, f) {
  const raw = row[f.field];
  const lv = num(raw);
  const rv = num(f.value);
  const bothNum = typeof lv === "number" && typeof rv === "number";
  switch (f.op) {
    case "eq":
      return String(raw) === String(f.value);
    case "ne":
      return String(raw) !== String(f.value);
    case "gt":
      return bothNum && lv > rv;
    case "gte":
      return bothNum && lv >= rv;
    case "lt":
      return bothNum && lv < rv;
    case "lte":
      return bothNum && lv <= rv;
    case "in":
      return Array.isArray(f.value) && f.value.map(String).includes(String(raw));
    default:
      return true;
  }
}

// ── aggregation ───────────────────────────────────────────────────────────────

function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeMeasure(rowsInGroup, m) {
  const agg = m.agg;
  if (agg === "count") return rowsInGroup.length;
  if (agg === "count_distinct") {
    return new Set(rowsInGroup.map((r) => String(r[m.field]))).size;
  }
  const values = rowsInGroup.map((r) => num(r[m.field])).filter((v) => typeof v === "number");
  if (values.length === 0) return null;
  switch (agg) {
    case "sum":
      return round1(values.reduce((s, x) => s + x, 0));
    case "mean":
      return round1(values.reduce((s, x) => s + x, 0) / values.length);
    case "rate":
      // mean of a 0/1 flag, expressed as a percentage (1 decimal).
      return round1((values.reduce((s, x) => s + x, 0) / values.length) * 100);
    case "min":
      return values.reduce((a, x) => (x < a ? x : a), values[0]);
    case "max":
      return values.reduce((a, x) => (x > a ? x : a), values[0]);
    default:
      return null;
  }
}

function measureLabel(m) {
  return m.agg === "count" ? "count" : `${m.agg}_${m.field}`;
}

/**
 * scrm_query engine.
 * @returns {{ table, group_by, measures, rows_scanned, groups, rows }}
 */
function runQuery(input, tables) {
  const table = input.table;
  if (!TABLE_NAMES.includes(table)) {
    return { error: `unknown table "${table}". Valid tables: ${TABLE_NAMES.join(", ")}.` };
  }
  const base = tables[table] || [];

  let rows = applyDerives(table, base, input.derive || [], tables);

  const filters = Array.isArray(input.filters) ? input.filters : [];
  for (const f of filters) rows = rows.filter((r) => passesFilter(r, f));
  const rowsScanned = rows.length;

  const groupBy = Array.isArray(input.group_by) ? input.group_by : [];
  const measures =
    Array.isArray(input.measures) && input.measures.length ? input.measures : [{ agg: "count" }];

  const groups = new Map();
  for (const r of rows) {
    const key = groupBy.map((g) => String(r[g])).join("||");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const outRows = [];
  for (const [key, groupRows] of groups) {
    const dimVals = key === "" ? [] : key.split("||");
    const row = {};
    groupBy.forEach((g, i) => {
      row[g] = dimVals[i];
    });
    for (const m of measures) row[measureLabel(m)] = computeMeasure(groupRows, m);
    outRows.push(row);
  }

  // Deterministic ordering: by group dimensions ascending.
  outRows.sort((a, b) => {
    for (const g of groupBy) {
      const av = String(a[g]);
      const bv = String(b[g]);
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return 0;
  });

  const limit = Number(input.limit) || 0;
  const limited = limit > 0 ? outRows.slice(0, limit) : outRows;
  return {
    table,
    group_by: groupBy,
    measures: measures.map(measureLabel),
    rows_scanned: rowsScanned,
    groups: outRows.length,
    rows: limited,
    ...(limited.length < outRows.length ? { truncated: true } : {}),
  };
}

// ── correlation (per-supplier, latest month) ─────────────────────────────────

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Build a supplier_key → numeric-value map for one correlation variable.
 * @returns {{ map: Map<string,number>, label: string } | { error: string }}
 */
function buildVariable(spec, tables, latestDate) {
  const source = spec && spec.source;
  const latestRows = (tables.risk_snapshots || []).filter(
    (r) => String(r.snapshot_date || "") === latestDate,
  );
  if (source === "kri_score") {
    const kri = String(spec.risk_category || "").trim();
    if (!kri) return { error: "kri_score requires risk_category (e.g. FINANCIAL, DELIVERY, CYBER)." };
    const map = new Map();
    for (const r of latestRows) {
      if (String(r.risk_category) !== kri) continue;
      const v = num(r.risk_score);
      if (typeof v === "number") map.set(r.supplier_key, v);
    }
    if (map.size === 0) return { error: `no latest-month rows for risk_category "${kri}".` };
    return { map, label: `${kri}_risk_score` };
  }
  if (source === "overall_risk") {
    // Honest overall-risk roll-up: per supplier, the mean of the latest month's
    // risk_score across ALL KRIs. This is the legitimate substitute for the excluded
    // composite_risk_pct — computed from the snapshots the agent can actually see.
    const acc = new Map();
    for (const r of latestRows) {
      const v = num(r.risk_score);
      if (typeof v !== "number") continue;
      if (!acc.has(r.supplier_key)) acc.set(r.supplier_key, []);
      acc.get(r.supplier_key).push(v);
    }
    const map = new Map();
    for (const [k, arr] of acc) map.set(k, arr.reduce((s, x) => s + x, 0) / arr.length);
    return { map, label: "overall_risk_mean_kri_score" };
  }
  if (source === "supplier_attr") {
    const field = String(spec.field || "").trim();
    if (!field) return { error: "supplier_attr requires field (e.g. established_year, contract_count)." };
    const map = new Map();
    for (const s of tables.suppliers || []) {
      const v = num(s[field]);
      if (typeof v === "number") map.set(s.supplier_key, v);
    }
    if (map.size === 0) {
      return {
        error: `supplier attribute "${field}" is not a numeric column (or is unavailable, e.g. composite_risk_pct is intentionally excluded). Numeric attributes: established_year, contract_count.`,
      };
    }
    return { map, label: `supplier.${field}` };
  }
  return {
    error: `unknown correlation source "${source}". Use "kri_score" (+risk_category), "overall_risk", or "supplier_attr" (+field).`,
  };
}

/**
 * scrm_correlation engine — Pearson r between two per-supplier variables, aligned on
 * supplier_key over the target month (latest by default).
 */
function runCorrelation(input, tables) {
  const latestDate = latestSnapshotDate(tables);
  const month = String(input.month || "latest").trim().toLowerCase();
  let targetDate = latestDate;
  if (month && month !== "latest") {
    // Accept a YYYY-MM period; resolve to that month's snapshot_date.
    const hit = (tables.risk_snapshots || []).find((r) => String(r.period_month || "") === month);
    if (!hit) return { error: `no snapshots for month "${input.month}". Use "latest" or a YYYY-MM present in the data.` };
    targetDate = String(hit.snapshot_date || latestDate);
  }

  const xv = buildVariable(input.x, tables, targetDate);
  if (xv.error) return { error: `x: ${xv.error}` };
  const yv = buildVariable(input.y, tables, targetDate);
  if (yv.error) return { error: `y: ${yv.error}` };

  const xs = [];
  const ys = [];
  for (const [k, xVal] of xv.map) {
    if (yv.map.has(k)) {
      xs.push(xVal);
      ys.push(yv.map.get(k));
    }
  }
  const r = pearson(xs, ys);
  if (r == null) {
    return { error: "not enough overlapping suppliers (or zero variance) to compute a correlation." };
  }
  const mean = (a) => round1(a.reduce((s, x) => s + x, 0) / a.length);
  return {
    method: "pearson",
    month: month === "latest" ? `latest (${targetDate})` : input.month,
    n: xs.length,
    r: round2(r),
    x: { ...xv0(input.x), label: xv.label, mean: mean(xs) },
    y: { ...xv0(input.y), label: yv.label, mean: mean(ys) },
  };
}

/** Echo the caller's variable spec (source + its selector) back in the result. */
function xv0(spec) {
  const s = spec || {};
  return {
    source: s.source,
    ...(s.risk_category ? { risk_category: s.risk_category } : {}),
    ...(s.field ? { field: s.field } : {}),
  };
}

// ── supplier profile (recommendation / triage support) ───────────────────────

function resolveSupplier(input, tables) {
  const suppliers = tables.suppliers || [];
  const key = String(input.supplier_key || "").trim();
  if (key) {
    const s = suppliers.find((x) => x.supplier_key === key);
    return s ? { supplier: s } : { error: `supplier_key "${key}" not found.` };
  }
  const name = String(input.supplier_name || "").trim().toLowerCase();
  if (!name) return { error: "supplier_key or supplier_name is required." };
  const exact = suppliers.filter((x) => String(x.supplier_name || "").toLowerCase() === name);
  if (exact.length === 1) return { supplier: exact[0] };
  const contains = suppliers.filter((x) => String(x.supplier_name || "").toLowerCase().includes(name));
  if (contains.length === 1) return { supplier: contains[0] };
  if (contains.length === 0) return { error: `no supplier matching "${input.supplier_name}".` };
  return {
    error: `ambiguous supplier "${input.supplier_name}"; candidates: ${contains
      .map((x) => `${x.supplier_key} (${x.supplier_name})`)
      .join(", ")}.`,
  };
}

function runSupplierProfile(input, tables) {
  const res = resolveSupplier(input, tables);
  if (res.error) return { error: res.error };
  const s = res.supplier;
  const key = s.supplier_key;
  const latestDate = latestSnapshotDate(tables);

  // Latest-month KRI posture (one row per KRI).
  const kris = (tables.risk_snapshots || [])
    .filter((r) => r.supplier_key === key && String(r.snapshot_date || "") === latestDate)
    .map((r) => ({
      risk_category: r.risk_category,
      risk_caption: r.risk_caption,
      risk_score: num(r.risk_score),
      threshold: num(r.threshold),
      rag_status: r.rag_status,
      mom_delta: num(r.mom_delta),
      direction_of_change: r.direction_of_change,
      alert_flag: r.alert_flag,
      alert_reason: r.alert_reason,
    }))
    .sort((a, b) => String(a.risk_category).localeCompare(String(b.risk_category)));

  // Single-source / Section 889 components.
  const myComponents = (tables.components || []).filter((c) => c.supplier_key === key);
  const ssConc = ssConcentratedMap(tables).get(key) || false;
  const singleSourceConcentrated = myComponents
    .filter(
      (c) =>
        String(c.single_source_flag || "").trim().toLowerCase() === "true" &&
        CONCENTRATED_REGIONS.has(String(c.country_of_origin || "").trim().toLowerCase()),
    )
    .map((c) => ({ component_name: c.component_name, country_of_origin: c.country_of_origin, criticality: c.criticality }));
  const section889 = myComponents
    .filter((c) => String(c.section_889_category || "None") !== "None")
    .map((c) => ({ component_name: c.component_name, section_889_category: c.section_889_category }));

  // Exposed contracts / programs.
  const contracts = (tables.contracts || [])
    .filter((c) => c.supplier_key === key)
    .map((c) => ({
      contract_id: c.contract_id,
      program_name: c.program_name,
      agency: c.agency,
      contract_value_usd: num(c.contract_value_usd),
      status: c.status,
    }));

  // Open findings (qualitative layer). progress_note is sanitized in the clean file.
  const findings = (tables.findings || [])
    .filter((f) => f.supplier_key === key)
    .map((f) => ({
      finding_id: f.finding_id,
      risk_category: f.risk_category,
      status: f.status,
      rag_status: f.rag_status,
      owner_function: f.owner_function,
      owning_channel: f.owning_channel,
      root_cause: f.root_cause,
      mitigation_goal: f.mitigation_goal,
      source: f.source,
      data_quality_flag: f.data_quality_flag,
    }));

  return {
    supplier: {
      supplier_key: s.supplier_key,
      supplier_name: s.supplier_name,
      sector: s.sector,
      portfolio: s.portfolio,
      portfolio_owner_user: s.portfolio_owner_user,
      agency: s.agency,
      criticality: s.criticality,
      country_of_ownership: s.country_of_ownership,
      ownership_type: s.ownership_type,
      foci_flag: s.foci_flag,
      small_business: s.small_business,
      established_year: num(s.established_year),
      contract_count: num(s.contract_count),
      performance_archetype: s.performance_archetype,
    },
    latest_month: latestDate,
    ss_concentrated: ssConc,
    kris,
    single_source_concentrated_components: singleSourceConcentrated,
    section_889_components: section889,
    exposed_contracts: contracts,
    open_findings: findings,
  };
}

// ── tool specs + dispatch ─────────────────────────────────────────────────────

const SCRM_TOOL_SPECS = [
  {
    name: "scrm_query",
    description:
      "Run a grouped aggregation over ONE SCRM table and get back summary rows. This is your primary analysis tool: compare groups and compute counts, rates, and means. " +
      `Tables: ${TABLE_NAMES.join(", ")}. ` +
      "risk_snapshots is the measure table (one row per supplier x KRI x month; the KRI score is `risk_score`, 0-100, higher = worse). suppliers, components, contracts, findings are dimension/detail tables. " +
      "You can add derived columns, filter rows, group by one or more dimensions, and compute measures. " +
      "IMPORTANT: risk_snapshots holds 18 months of history — the CURRENT risk posture is the LATEST month. Add the derived column `is_latest_month` and filter it to \"yes\" to analyze current scores (otherwise you average across all months). " +
      "To relate a signal that lives in another table to a KRI score, use the provided derived columns rather than trying to join tables yourself: `ss_concentrated` (whether a supplier has multiple single-source parts from a geographically concentrated region, computed from components) and the supplier attributes `small_business` / `established_year` / `contract_count` (attached by supplier_key). Do NOT ask for one table joined into another — that fans out and inflates counts. " +
      "The column scrm_suppliers.composite_risk_pct is intentionally unavailable (a circular validation roll-up). To gauge a supplier's OVERALL risk, aggregate risk_score across its KRIs (or use scrm_correlation's overall_risk source) — never a precomputed composite.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", enum: TABLE_NAMES, description: "The table to query." },
        derive: {
          type: "array",
          items: { type: "string", enum: DERIVE_NAMES },
          description:
            "Optional derived columns to add before grouping. is_latest_month (risk_snapshots): yes/no whether the row is in the most recent snapshot month. ss_concentrated: yes/no whether the supplier has >=2 single-source components from a concentrated region (China/Taiwan). small_business / established_year / contract_count: the supplier's attribute, attached by supplier_key (use on risk_snapshots to relate a supplier attribute to risk_score).",
        },
        filters: {
          type: "array",
          description: "Row filters, ANDed together.",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              op: { type: "string", enum: ["eq", "ne", "gt", "gte", "lt", "lte", "in"] },
              value: {},
            },
            required: ["field", "op", "value"],
          },
        },
        group_by: {
          type: "array",
          items: { type: "string" },
          description:
            "Dimension columns (raw or derived) to group by, e.g. foci_flag, sector, criticality, risk_category, ss_concentrated. Omit for a single overall aggregate.",
        },
        measures: {
          type: "array",
          description: "Aggregations to compute per group. Defaults to a row count.",
          items: {
            type: "object",
            properties: {
              agg: {
                type: "string",
                enum: ["count", "count_distinct", "mean", "sum", "rate", "min", "max"],
                description: "mean/sum/min/max over `field`; rate = mean of a 0/1 flag as a percentage; count_distinct = distinct values of `field`.",
              },
              field: { type: "string", description: "Column to aggregate (not needed for count). Usually risk_score." },
            },
            required: ["agg"],
          },
        },
        limit: { type: "number", description: "Max groups to return." },
      },
      required: ["table"],
    },
  },
  {
    name: "scrm_correlation",
    description:
      "Compute the Pearson correlation (r) between two per-supplier numeric variables, aligned on supplier for one month (latest by default). Use this to characterize the STRENGTH and DIRECTION of a linear relationship (e.g. does a supplier's financial-distress KRI track its delivery KRI?), and to test whether a supplier attribute actually relates to risk. Each variable is one of: a KRI score (source=kri_score + risk_category), an honest overall-risk roll-up (source=overall_risk = mean of the supplier's latest KRI scores), or a numeric supplier attribute (source=supplier_attr + field, e.g. established_year, contract_count). Correlation is NOT causation — a strong r can be confounded.",
    inputSchema: {
      type: "object",
      properties: {
        x: {
          type: "object",
          properties: {
            source: { type: "string", enum: ["kri_score", "overall_risk", "supplier_attr"] },
            risk_category: { type: "string", description: "For source=kri_score, e.g. FINANCIAL, DELIVERY, CYBER, PROHIBITED_SRC." },
            field: { type: "string", description: "For source=supplier_attr, a numeric column e.g. established_year, contract_count." },
          },
          required: ["source"],
        },
        y: {
          type: "object",
          properties: {
            source: { type: "string", enum: ["kri_score", "overall_risk", "supplier_attr"] },
            risk_category: { type: "string" },
            field: { type: "string" },
          },
          required: ["source"],
        },
        month: { type: "string", description: 'Target month: "latest" (default) or a YYYY-MM present in the data.' },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "scrm_supplier_profile",
    description:
      "Pull a full drill-down profile for ONE supplier: identity (sector, portfolio + owner, criticality, ownership/FOCI), its latest-month KRI posture (score, threshold, RAG, month-over-month change, alert) for all 7 KRIs, single-source & Section 889 components, exposed contracts/programs, and open risk findings (root cause, mitigation, source, any data-quality flag). Use this to build a triage recommendation or to explain WHY a supplier's risk moved. Identify the supplier by supplier_key (e.g. SUP-001) or supplier_name.",
    inputSchema: {
      type: "object",
      properties: {
        supplier_key: { type: "string", description: "e.g. SUP-001." },
        supplier_name: { type: "string", description: "e.g. Meridian Microelectronics (exact or unambiguous substring)." },
      },
    },
  },
];

/**
 * Dispatch a SCRM tool call.
 * @param {string} name
 * @param {object} input
 * @param {{ dataDir?: string, tables?: object }} [opts]  test seam: inject tables/dir
 * @returns {Promise<object>}
 */
async function dispatchScrmTool(name, input = {}, opts = {}) {
  const tables = opts.tables || loadTables(opts.dataDir);
  switch (name) {
    case "scrm_query":
      return runQuery(input, tables);
    case "scrm_correlation":
      return runCorrelation(input, tables);
    case "scrm_supplier_profile":
      return runSupplierProfile(input, tables);
    default:
      return { error: `unknown SCRM tool "${name}".` };
  }
}

module.exports = {
  SCRM_TOOL_SPECS,
  dispatchScrmTool,
  // exported for unit tests
  runQuery,
  runCorrelation,
  runSupplierProfile,
  applyDerives,
  ssConcentratedMap,
  latestSnapshotDate,
  pearson,
  TABLE_NAMES,
  DERIVE_NAMES,
  CONCENTRATED_REGIONS,
};
