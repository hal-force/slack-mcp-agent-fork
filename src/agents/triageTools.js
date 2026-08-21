/**
 * triageTools — the tool surface the triage specialist calls.
 *
 * Three tools, in Bedrock Converse `{ name, description, inputSchema }` shape
 * (same as TABLEAU_TOOL_SPECS), dispatched by dispatchTriageTool(name, input):
 *
 *   1. triage_query          — grouped aggregation over ONE table (the agent's
 *                              primary analysis primitive: compare groups, compute
 *                              rates/means). Mirrors a VizQL query-datasource call.
 *   2. triage_skill_gap      — required/covered/missing skills for a patient×nurse,
 *                              computed WITHOUT fanning out the two skill bridges.
 *   3. triage_list_nurses_on_shift — candidate nurses + caseload + (optional) per-
 *                              nurse skill match for a new patient (recommendation).
 *
 * The tools carry NO knowledge of which group comparisons reveal a planted effect
 * — the specialist has to find them. They also refuse to surface the validation-
 * aid column (see triageData.FORBIDDEN_COLUMNS): the honest way to analyze skill
 * match at the patient level is the derived `patient_mean_skill_match`, computed
 * here from the assignments table.
 *
 * At M4 this whole module is repointed at the published Tableau datasources via
 * the MCP; the specialist prompt and the tool names/shapes do not change.
 */

const { loadTables, num } = require("./triageData");

const TABLE_NAMES = [
  "patients",
  "nurses",
  "assignments",
  "nurse_skills",
  "patient_required_skills",
  "unit_snapshots",
  "clinical_notes",
  "skills_reference",
];

const DERIVE_NAMES = [
  "comorbidity_present",
  "patient_mean_skill_match",
  "skill_match_bucket",
  "age_band",
];

const DEFAULT_SKILL_MATCH_THRESHOLD = 75;

// ── derived-column helpers ──────────────────────────────────────────────────

/** patient_id → mean of that patient's assignment skill_match_pct (honest path). */
function patientMeanSkillMatch(tables) {
  const byPatient = new Map();
  for (const a of tables.assignments || []) {
    const pid = a.patient_id;
    const v = num(a.skill_match_pct);
    if (pid == null || typeof v !== "number") continue;
    if (!byPatient.has(pid)) byPatient.set(pid, []);
    byPatient.get(pid).push(v);
  }
  const out = new Map();
  for (const [pid, arr] of byPatient) {
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    out.set(pid, Math.round(mean * 10) / 10);
  }
  return out;
}

function ageBand(age) {
  const a = num(age);
  if (typeof a !== "number") return "unknown";
  if (a < 40) return "<40";
  if (a < 55) return "40-54";
  if (a < 70) return "55-69";
  if (a < 85) return "70-84";
  return "85+";
}

/**
 * Apply requested derived columns to a copy of the rows.
 * @param {string} table
 * @param {Array<object>} rows
 * @param {string[]} derive
 * @param {number} threshold  skill_match_bucket cut point
 * @param {object} tables     full table set (needed for cross-table derives)
 */
function applyDerives(table, rows, derive, threshold, tables) {
  if (!derive || derive.length === 0) return rows.map((r) => ({ ...r }));
  const want = new Set(derive);
  let meanMap = null;
  if (want.has("patient_mean_skill_match") || want.has("skill_match_bucket")) {
    meanMap = patientMeanSkillMatch(tables);
  }
  return rows.map((r) => {
    const row = { ...r };
    if (want.has("comorbidity_present")) {
      const c = (r.comorbidity || "").trim();
      row.comorbidity_present = c && c.toLowerCase() !== "none" ? "yes" : "no";
    }
    if (want.has("age_band")) {
      row.age_band = ageBand(r.age);
    }
    if (meanMap && (table === "patients" || table === "assignments")) {
      const pid = r.patient_id;
      const mean = meanMap.has(pid) ? meanMap.get(pid) : null;
      if (want.has("patient_mean_skill_match")) row.patient_mean_skill_match = mean;
      if (want.has("skill_match_bucket")) {
        row.skill_match_bucket =
          mean == null ? "unknown" : mean >= threshold ? `high (>=${threshold})` : `low (<${threshold})`;
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

function computeMeasure(rowsInGroup, m) {
  const agg = m.agg;
  if (agg === "count") return rowsInGroup.length;
  const values = rowsInGroup
    .map((r) => num(r[m.field]))
    .filter((v) => typeof v === "number");
  if (agg === "count_distinct") {
    return new Set(rowsInGroup.map((r) => String(r[m.field]))).size;
  }
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
      // reduce, not Math.min(...values): spreading up to DEFAULT_ROW_LIMIT
      // (100k) values as call args can blow the argument-count/stack limit.
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
 * triage_query engine.
 * @returns {{ table, group_by, rows_scanned, groups, rows }}
 */
function runQuery(input, tables) {
  const table = input.table;
  if (!TABLE_NAMES.includes(table)) {
    return { error: `unknown table "${table}". Valid tables: ${TABLE_NAMES.join(", ")}.` };
  }
  const base = tables[table] || [];
  const threshold =
    typeof input.skill_match_threshold === "number"
      ? input.skill_match_threshold
      : DEFAULT_SKILL_MATCH_THRESHOLD;

  let rows = applyDerives(table, base, input.derive || [], threshold, tables);

  const filters = Array.isArray(input.filters) ? input.filters : [];
  for (const f of filters) rows = rows.filter((r) => passesFilter(r, f));
  const rowsScanned = rows.length;

  const groupBy = Array.isArray(input.group_by) ? input.group_by : [];
  const measures =
    Array.isArray(input.measures) && input.measures.length
      ? input.measures
      : [{ agg: "count" }];

  // No group_by → one global aggregate row.
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

// ── skill gap (fan-out-safe) ──────────────────────────────────────────────────

function skillNameMap(tables) {
  const m = new Map();
  for (const s of tables.skills_reference || []) m.set(s.skill_id, s.skill_name);
  return m;
}

/**
 * Compute the skill gap for a patient against a specific nurse (or just the
 * patient's requirements if no nurse). Never fans out — it intersects two SETS.
 */
function computeSkillGap(tables, patientId, nurseId) {
  const names = skillNameMap(tables);
  const required = [];
  const reqSet = new Set();
  for (const r of tables.patient_required_skills || []) {
    if (r.patient_id !== patientId) continue;
    if (reqSet.has(r.skill_id)) continue;
    reqSet.add(r.skill_id);
    required.push({ skill_id: r.skill_id, skill_name: r.skill_name || names.get(r.skill_id) || r.skill_id });
  }
  const nurseSkills = new Set();
  if (nurseId) {
    for (const n of tables.nurse_skills || []) {
      if (n.nurse_id === nurseId) nurseSkills.add(n.skill_id);
    }
  }
  const covered = required.filter((s) => nurseSkills.has(s.skill_id));
  const missing = required.filter((s) => !nurseSkills.has(s.skill_id));
  const matchPct = required.length ? round1((covered.length / required.length) * 100) : 100.0;
  return {
    patient_id: patientId,
    nurse_id: nurseId || null,
    required,
    covered: nurseId ? covered : [],
    missing: nurseId ? missing : [],
    required_count: required.length,
    covered_count: nurseId ? covered.length : 0,
    match_pct: nurseId ? matchPct : null,
  };
}

function runSkillGap(input, tables) {
  let patientId = input.patient_id;
  let nurseId = input.nurse_id || null;
  if (input.assignment_id) {
    const asn = (tables.assignments || []).find((a) => a.assignment_id === input.assignment_id);
    if (!asn) return { error: `assignment_id "${input.assignment_id}" not found.` };
    patientId = patientId || asn.patient_id;
    nurseId = nurseId || asn.nurse_id;
  }
  if (!patientId) return { error: "patient_id (or a resolvable assignment_id) is required." };
  const patient = (tables.patients || []).find((p) => p.patient_id === patientId);
  if (!patient) return { error: `patient_id "${patientId}" not found.` };
  return computeSkillGap(tables, patientId, nurseId);
}

// ── nurses on shift (recommendation support) ─────────────────────────────────

/**
 * CURRENT caseload per nurse = assignments on that nurse's MOST RECENT shift, not
 * every assignment they have ever had. The assignments table is a month-long log
 * (hundreds of shifts), so a naive count yields absurd loads (100+), which both
 * reads as broken on the recommendation card and corrupts the ranker's workload
 * penalty (every nurse clamps to a full load, so the penalty cancels out and the
 * ranking degenerates to skill-match-only). We take each nurse's latest shift_start
 * and count only the assignments on it. When shift_start is absent (mini fixtures),
 * all of a nurse's rows share an undefined "latest shift" and are counted — the
 * previous behaviour, so small fixtures are unaffected.
 */
function nurseCaseload(tables) {
  const assignments = tables.assignments || [];
  const latestShift = new Map();
  for (const a of assignments) {
    const s = a.shift_start;
    const cur = latestShift.get(a.nurse_id);
    if (cur === undefined || String(s) > String(cur)) latestShift.set(a.nurse_id, s);
  }
  const m = new Map();
  for (const a of assignments) {
    if (a.shift_start === latestShift.get(a.nurse_id)) {
      m.set(a.nurse_id, (m.get(a.nurse_id) || 0) + 1);
    }
  }
  return m;
}

function runListNurses(input, tables) {
  const caseload = nurseCaseload(tables);
  const skillsByNurse = new Map();
  for (const n of tables.nurse_skills || []) {
    if (!skillsByNurse.has(n.nurse_id)) skillsByNurse.set(n.nurse_id, []);
    skillsByNurse.get(n.nurse_id).push(n.skill_id);
  }
  let nurses = tables.nurses || [];
  if (input.unit) nurses = nurses.filter((n) => n.home_unit === input.unit);
  if (input.shift_pattern) nurses = nurses.filter((n) => n.shift_pattern === input.shift_pattern);

  const patientId = input.patient_id || null;
  const out = nurses.map((n) => {
    const rec = {
      nurse_id: n.nurse_id,
      nurse_name: n.nurse_name,
      home_unit: n.home_unit,
      shift_pattern: n.shift_pattern,
      experience_years: num(n.experience_years),
      certification: n.certification,
      max_caseload: num(n.max_caseload),
      current_caseload: caseload.get(n.nurse_id) || 0,
      skill_ids: skillsByNurse.get(n.nurse_id) || [],
    };
    if (patientId) {
      const gap = computeSkillGap(tables, patientId, n.nurse_id);
      rec.skill_match_pct = gap.match_pct;
      rec.missing_skills = gap.missing.map((s) => s.skill_id);
    }
    return rec;
  });
  return { count: out.length, unit: input.unit || null, patient_id: patientId, nurses: out };
}

// ── tool specs + dispatch ─────────────────────────────────────────────────────

const TRIAGE_TOOL_SPECS = [
  {
    name: "triage_query",
    description:
      "Run a grouped aggregation over ONE triage table and get back summary rows. This is your primary analysis tool: compare groups and compute counts, rates, and means. " +
      `Tables: ${TABLE_NAMES.join(", ")}. ` +
      "You can add derived columns, filter rows, group by one or more dimensions, and compute measures. " +
      "Do NOT try to join the skill bridges (nurse_skills / patient_required_skills) into another table — that fans out and inflates every count; use triage_skill_gap for skill coverage. " +
      "The column patients.mean_skill_match_pct is intentionally unavailable (it is a validation aid). To analyze skill match at the PATIENT level, add the derived column patient_mean_skill_match (computed honestly from the assignments table) and/or skill_match_bucket.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", enum: TABLE_NAMES, description: "The table to query." },
        derive: {
          type: "array",
          items: { type: "string", enum: DERIVE_NAMES },
          description:
            "Optional derived columns to add before grouping. comorbidity_present: yes/no from patients.comorbidity. patient_mean_skill_match: a patient's mean assignment skill_match_pct (from assignments; the legitimate patient-level skill-match measure). skill_match_bucket: high/low split of patient_mean_skill_match at skill_match_threshold. age_band: banded patient age.",
        },
        skill_match_threshold: {
          type: "number",
          description: "Cut point for skill_match_bucket (default 75).",
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
          description: "Dimension columns (raw or derived) to group by. Omit for a single overall aggregate.",
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
                description: "rate = mean of a 0/1 flag as a percentage (use for adverse_outcome).",
              },
              field: { type: "string", description: "Column to aggregate (not needed for count)." },
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
    name: "triage_skill_gap",
    description:
      "Compute the skill gap between a patient's required skills and a nurse's skills WITHOUT fan-out. Give patient_id plus either nurse_id or assignment_id (which resolves the nurse). Returns required[], covered[], missing[], and match_pct. Prefer this over any manual join of the skill bridges.",
    inputSchema: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "e.g. PT0123." },
        nurse_id: { type: "string", description: "e.g. RN007. Omit to see only the patient's requirements." },
        assignment_id: { type: "string", description: "e.g. ASN00001; resolves patient+nurse from the assignment." },
      },
    },
  },
  {
    name: "triage_list_nurses_on_shift",
    description:
      "List candidate nurses for assignment with caseload and skills, to build a recommendation for a newly admitted patient. Optional unit / shift_pattern filters. If patient_id is given, each nurse also gets skill_match_pct and missing_skills for that patient. Rank by skill match minus workload (higher caseload = more loaded).",
    inputSchema: {
      type: "object",
      properties: {
        unit: { type: "string", description: "Filter to a home_unit (e.g. ICU-A, Med-Surg, Step-Down)." },
        shift_pattern: { type: "string", description: "Filter to a shift pattern (e.g. Day, Night)." },
        patient_id: { type: "string", description: "If set, also compute per-nurse skill match for this patient." },
      },
    },
  },
];

/**
 * Dispatch a triage tool call.
 * @param {string} name
 * @param {object} input
 * @param {{ dataDir?: string, tables?: object }} [opts]  test seam: inject tables/dir
 * @returns {Promise<object>}
 */
async function dispatchTriageTool(name, input = {}, opts = {}) {
  const tables = opts.tables || loadTables(opts.dataDir);
  switch (name) {
    case "triage_query":
      return runQuery(input, tables);
    case "triage_skill_gap":
      return runSkillGap(input, tables);
    case "triage_list_nurses_on_shift":
      return runListNurses(input, tables);
    default:
      return { error: `unknown triage tool "${name}".` };
  }
}

module.exports = {
  TRIAGE_TOOL_SPECS,
  dispatchTriageTool,
  // exported for unit tests
  runQuery,
  runSkillGap,
  runListNurses,
  computeSkillGap,
  patientMeanSkillMatch,
  TABLE_NAMES,
  DERIVE_NAMES,
};
