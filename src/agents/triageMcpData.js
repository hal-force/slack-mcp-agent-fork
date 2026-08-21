/**
 * triageMcpData — the Tableau-MCP backend for the triage specialist's tools (M4).
 *
 * This is the ONE piece the design (docs/MULTI-AGENT-TRIAGE-DESIGN.md §7, M4) says
 * gets swapped when the triage data moves off local CSVs and onto published Tableau
 * datasources: it materializes the SAME `{ table: rows[] }` shape that
 * triageData.loadTables() produces, but by querying the Tableau MCP server instead
 * of reading files. Because it reproduces that shape exactly, triageTools.js and the
 * specialist prompt are untouched — dispatchTriageTool just receives `{ tables }`.
 *
 * ── Parity with the CSV backend ───────────────────────────────────────────────
 * - Row objects are keyed by the SAME canonical snake_case column names the tools
 *   reference (patient_id, acuity_level, skill_match_pct, …). Tableau may surface a
 *   column as a Title-Cased caption ("Patient Id"); we resolve captions back to the
 *   canonical name so the tools don't have to know the difference.
 * - Every value is stringified, matching the CSV parser's all-strings output, so the
 *   tools' num()/String() coercions and the locked eval magnitudes behave identically.
 * - FORBIDDEN_COLUMNS (mean_skill_match_pct) are stripped on read here too. Per the
 *   M4 decision this is belt-and-suspenders: the published patients datasource is
 *   filtered to omit the column, AND we strip it here in case a raw source reappears.
 *
 * ── The answer-key invariant (unchanged) ──────────────────────────────────────
 * This module talks ONLY to the Tableau MCP server for agent-facing data. It never
 * reads anything under tests/eval/triage/ (GROUND_TRUTH.md, manifest.json, …).
 */

const { callTableauTool } = require("../assistant/tableauMcpClient");
const { FORBIDDEN_COLUMNS } = require("./triageData");

// The canonical columns the tools expect per table. Used both to request the right
// fields from VDS and to re-key returned rows back to canonical names. mean_skill_match_pct
// is intentionally absent from `patients` (the filtered publish omits it; we also strip it).
const TABLE_COLUMNS = {
  patients: [
    "patient_id", "patient_name", "age", "sex", "admit_datetime", "discharge_datetime",
    "diagnosis", "acuity_level", "acuity_score", "risk_score", "comorbidity", "symptoms",
    "los_hours", "outcome", "adverse_outcome", "data_classification",
  ],
  nurses: [
    "nurse_id", "nurse_name", "experience_years", "home_unit", "certification",
    "shift_pattern", "max_caseload", "skill_count", "data_classification",
  ],
  nurse_skills: ["nurse_id", "skill_id", "skill_name", "data_classification"],
  patient_required_skills: ["patient_id", "skill_id", "skill_name", "data_classification"],
  assignments: [
    "assignment_id", "patient_id", "nurse_id", "shift_start", "shift_end", "shift_sequence",
    "assigned_unit", "skill_match_pct", "caseload_at_assignment", "workload_score",
    "assignment_method", "data_classification",
  ],
  unit_snapshots: [
    "snapshot_datetime", "unit", "census", "capacity", "occupancy_pct", "nurses_on_shift",
    "patient_nurse_ratio", "avg_acuity_score", "unit_risk_score", "data_classification",
  ],
  clinical_notes: [
    "note_id", "patient_id", "patient_name", "note_type", "note_type_full", "note_datetime",
    "provider", "provider_role", "acuity_level", "diagnosis", "comorbidity", "note_text",
    "data_classification",
  ],
  skills_reference: ["skill_id", "skill_name", "skill_category", "data_classification"],
};

const TABLE_NAMES = Object.keys(TABLE_COLUMNS);

// The column(s) that uniquely identify a row in each table. A dimension-only VDS
// query returns one row per DISTINCT combination of requested fields; as long as a
// true unique key is among the requested fields, distinct-combinations == real rows.
// If the key column ever fails to resolve (renamed caption, filtered publish), rows
// collapse on the remaining columns and counts come back silently undercounted. We
// use these keys only for a best-effort sanity WARNING — never to alter results.
const TABLE_UNIQUE_KEYS = {
  patients: ["patient_id"],
  nurses: ["nurse_id"],
  nurse_skills: ["nurse_id", "skill_id"],
  patient_required_skills: ["patient_id", "skill_id"],
  assignments: ["assignment_id"],
  unit_snapshots: ["snapshot_datetime", "unit"],
  clinical_notes: ["note_id"],
  skills_reference: ["skill_id"],
};

// Generous per-table row cap. The largest table (clinical_notes) is ~3.7k rows; this
// leaves headroom without being unbounded.
const DEFAULT_ROW_LIMIT = 100000;

/** Normalize a column/caption for matching: lowercase, strip non-alphanumerics. */
function canonKey(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve the table→datasourceLUID map from an explicit override or the
 * TRIAGE_MCP_DATASOURCES env var (JSON object). Only tables present in the map are
 * fetched; absent tables become empty (the tools already report "no data" for those).
 * @param {Record<string,string>} [explicit]
 * @returns {Record<string,string>}
 */
function resolveDatasourceMap(explicit) {
  if (explicit && typeof explicit === "object") return explicit;
  const raw = String(process.env.TRIAGE_MCP_DATASOURCES || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Pull the row array out of a query-datasource response body. VDS returns
 * `{ "data": [ {caption: value, …}, … ] }`; tolerate a bare array too.
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
function parseVdsData(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  let j;
  try {
    j = JSON.parse(s);
  } catch (_) {
    return [];
  }
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.data)) return j.data;
  return [];
}

/**
 * Extract candidate field captions from a get-datasource-metadata response. The
 * server's exact shape varies; collect field descriptors from the common shapes:
 *   - a bare array, or {data|fields|columns: [...]}                (flat)
 *   - {fieldGroups: [{ fields: [{name|fieldCaption|caption}] }]}   (Tableau v4 VDS —
 *     one group per logical table; this is what federal-tableau-mcp actually returns)
 * Each descriptor may be a string or an object with a caption/name key.
 * @param {string} text
 * @returns {string[]}
 */
function parseMetadataCaptions(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  let j;
  try {
    j = JSON.parse(s);
  } catch (_) {
    return [];
  }
  // Gather the field descriptors from whichever shape we got. fieldGroups is the
  // real Tableau VDS shape; the flat keys are tolerated for other servers/mocks.
  let arr = [];
  if (Array.isArray(j)) arr = j;
  else if (Array.isArray(j.data)) arr = j.data;
  else if (Array.isArray(j.fields)) arr = j.fields;
  else if (Array.isArray(j.columns)) arr = j.columns;
  else if (Array.isArray(j.fieldGroups)) {
    for (const g of j.fieldGroups) {
      if (g && Array.isArray(g.fields)) arr.push(...g.fields);
    }
  }
  const caps = [];
  for (const f of arr) {
    if (f == null) continue;
    if (typeof f === "string") {
      caps.push(f);
      continue;
    }
    const cap = f.fieldCaption || f.caption || f.fieldName || f.name;
    if (cap) caps.push(String(cap));
  }
  return caps;
}

/**
 * Build a canonical-column → caption resolver for one table. For each canonical
 * column, pick the metadata caption whose canonKey matches. Falls back to the
 * canonical name itself when metadata yields nothing (the common Hyper case where
 * captions equal the source column names).
 * @param {string[]} canonicalColumns
 * @param {string[]} captions
 * @returns {Map<string,string>}  canonicalColumn → captionToRequest
 */
function buildCaptionResolver(canonicalColumns, captions) {
  const byKey = new Map();
  for (const cap of captions) byKey.set(canonKey(cap), cap);
  const out = new Map();
  for (const col of canonicalColumns) {
    if (FORBIDDEN_COLUMNS.has(col)) continue; // never request a forbidden column
    const hit = byKey.get(canonKey(col));
    if (hit) out.set(col, hit);
    else if (captions.length === 0) out.set(col, col); // no metadata → assume caption == column
  }
  return out;
}

/**
 * Fetch one table's full row set from its published datasource and re-key rows to
 * canonical column names, stringified, forbidden columns stripped.
 * @param {object} args
 * @param {string} args.table
 * @param {string} args.luid
 * @param {(name:string, input:object)=>Promise<{text:string}>} args.callTool
 * @param {number} [args.limit]
 * @returns {Promise<Array<Record<string,string>>>}
 */
async function fetchTable({ table, luid, callTool, limit = DEFAULT_ROW_LIMIT }) {
  const canonicalColumns = TABLE_COLUMNS[table] || [];

  // 1. Discover captions (best-effort; empty metadata → assume caption == column name).
  let captions = [];
  try {
    const meta = await callTool("get-datasource-metadata", { datasourceLuid: luid });
    captions = parseMetadataCaptions(meta && meta.text);
  } catch (_) {
    captions = [];
  }

  const resolver = buildCaptionResolver(canonicalColumns, captions);
  if (resolver.size === 0) return [];

  // Guard the distinct-combination assumption: a dimension-only VDS query returns
  // one row per DISTINCT field combination, so it only equals the true row set when
  // the table's unique key is among the resolved fields. If the key column didn't
  // resolve (renamed/filtered), warn — rows would otherwise collapse and undercount
  // with no error. Best-effort only; we never drop the fetch.
  const uniqueKey = TABLE_UNIQUE_KEYS[table] || [];
  const missingKeyCols = uniqueKey.filter((col) => !resolver.has(col));
  if (uniqueKey.length && missingKeyCols.length) {
    console.warn(
      `[triageMcpData] ${table}: unique-key column(s) [${missingKeyCols.join(", ")}] did not resolve to a datasource field — a dimension-only query may de-duplicate rows and undercount. Check the published datasource's field captions.`,
    );
  }

  // 2. Query all resolved fields as dimensions (no aggregation → one row per distinct
  //    combination; the unique-key check above guards against silent row collapse).
  const fields = [...resolver.values()].map((caption) => ({ fieldCaption: caption }));
  const query = { fields };
  const res = await callTool("query-datasource", { datasourceLuid: luid, query, limit });
  const rawRows = parseVdsData(res && res.text);

  // 3. Re-key caption→canonical, stringify, strip forbidden. captionByKey lets us read
  //    each returned row regardless of exact caption spelling.
  const captionToCanon = new Map();
  for (const [col, cap] of resolver.entries()) captionToCanon.set(canonKey(cap), col);

  const rows = rawRows.map((row) => {
    const clean = {};
    for (const [k, v] of Object.entries(row || {})) {
      const col = captionToCanon.get(canonKey(k));
      if (!col) continue; // an unexpected extra column — ignore
      if (FORBIDDEN_COLUMNS.has(col)) continue; // belt-and-suspenders strip
      clean[col] = v == null ? "" : String(v);
    }
    return clean;
  });

  // Post-fetch sanity: when the unique key DID resolve, the count of distinct key
  // tuples should equal the row count. If it doesn't, VDS de-duplicated on rendered
  // values (or the key isn't actually unique in the published source) and downstream
  // counts/rates are undercounted. Warn — never mutate the result.
  if (uniqueKey.length && missingKeyCols.length === 0 && rows.length > 1) {
    const distinctKeys = new Set(rows.map((r) => uniqueKey.map((c) => r[c]).join(" ")));
    if (distinctKeys.size !== rows.length) {
      console.warn(
        `[triageMcpData] ${table}: ${rows.length} rows but only ${distinctKeys.size} distinct [${uniqueKey.join(", ")}] — the datasource may have collapsed rows; counts/rates could be undercounted.`,
      );
    }
  }

  return rows;
}

/**
 * Load the full `{ table: rows[] }` set from Tableau MCP. Every table declared in the
 * datasource map is fetched; tables not in the map come back empty (the tools degrade
 * to "no data" for those, exactly as with a missing CSV).
 *
 * ── Why SEQUENTIAL, not parallel ──────────────────────────────────────────────
 * The MCP server authenticates to Tableau with a single PAT under http transport, and
 * a single PAT cannot be used concurrently: simultaneous Tableau signins terminate each
 * other's session, so firing all 8 table fetches at once collides on the shared MCP
 * session and silently drops rows for all but the race-winner (observed live: only the
 * last table returned data). Each fetchTable is TWO round-trips (metadata + query), so
 * we serialize per table. If the server ever moves to OAuth (per-request sessions), an
 * opts.concurrent could re-enable parallelism; today sequential is the correct default.
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.datasources]  table → datasourceLuid (else env)
 * @param {(name:string, input:object)=>Promise<{text:string}>} [opts.callTool]  test seam
 * @param {number} [opts.limit]
 * @returns {Promise<Record<string, Array<Record<string,string>>>>}
 */
async function loadTablesFromMcp(opts = {}) {
  const dsMap = resolveDatasourceMap(opts.datasources);
  const callTool = typeof opts.callTool === "function" ? opts.callTool : callTableauTool;
  const limit = Number(opts.limit) || DEFAULT_ROW_LIMIT;

  const tables = {};
  for (const t of TABLE_NAMES) tables[t] = []; // every table key present, even if unpublished

  const entries = Object.entries(dsMap).filter(([t, luid]) => TABLE_NAMES.includes(t) && luid);
  for (const [table, luid] of entries) {
    tables[table] = await fetchTable({ table, luid: String(luid), callTool, limit });
  }
  return tables;
}

/**
 * Build a dispatchTool that runs the triage tools against MCP-backed tables. The
 * tables are fetched once on first use and cached for the life of the dispatcher
 * (i.e. one specialist turn), then handed to the UNCHANGED dispatchTriageTool via its
 * `{ tables }` seam. Inject this at createTriageSpecialist({ dispatchTool }).
 *
 * @param {object} [opts]  same shape as loadTablesFromMcp's opts
 * @returns {(name:string, input:object)=>Promise<object>}
 */
function makeMcpDispatchTool(opts = {}) {
  const { dispatchTriageTool } = require("./triageTools");
  let tablesPromise = null;
  return async function dispatch(name, input) {
    if (!tablesPromise) tablesPromise = loadTablesFromMcp(opts);
    const tables = await tablesPromise;
    return dispatchTriageTool(name, input, { tables });
  };
}

module.exports = {
  TABLE_COLUMNS,
  TABLE_NAMES,
  canonKey,
  resolveDatasourceMap,
  parseVdsData,
  parseMetadataCaptions,
  buildCaptionResolver,
  fetchTable,
  loadTablesFromMcp,
  makeMcpDispatchTool,
};
