/**
 * scrmData — the local fixture backend for the SCRM specialist's tools.
 *
 * The SCRM (supply-chain-risk-management) specialist reasons over the synthetic
 * federal fixture in `demo-data/scrm/`. For offline/deterministic runs this data is
 * read directly from the bundled CSVs so the eval runs without a network. At M4 the
 * SAME tool surface (src/agents/scrmTools.js) is repointed at the published Tableau
 * datasources via the MCP (src/agents/scrmMcpData.js) — this module is the piece that
 * gets swapped, not the tools or the specialist prompt.
 *
 * ── The answer-key invariant ──────────────────────────────────────────────
 * This module reads ONLY from `demo-data/scrm/` (agent-facing data + a neutral
 * dictionary). It must NEVER read anything under `tests/eval/scrm/` (GROUND_TRUTH.md,
 * manifest.json, questions.json's answer material). Doing so would hand the agent the
 * planted-effect magnitudes it is supposed to discover. It also refuses to expose
 * `scrm_suppliers.composite_risk_pct` (a circular validation roll-up; see the fixture
 * README) so the agent can't read supplier risk off a precomputed column.
 *
 * Everything here is standard-library only (no CSV dependency) — the fixture's own
 * constraint, mirrored on the consuming side. This is a near-verbatim clone of
 * triageData.js with the SCRM tables and forbidden column.
 */

const fs = require("fs");
const path = require("path");

// Agent-facing data dir. Overridable for tests, but defaults to the bundled fixture.
// Deliberately NOT configurable to point anywhere near tests/eval.
const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "demo-data", "scrm");

// Column excluded from every agent-facing table: composite_risk_pct is a weighted
// roll-up of the very KRI scores the agent is asked to analyze (circular). The
// published suppliers datasource already omits it; we strip it here too so the local
// CSV backend can't surface it either (belt-and-suspenders).
const FORBIDDEN_COLUMNS = new Set(["composite_risk_pct"]);

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas, embedded
 * newlines, and doubled "" escapes. Returns an array of row objects keyed by the
 * header row. Standard-library only. (Identical to triageData.parseCsv.)
 * @param {string} text
 * @returns {Array<Record<string,string>>}
 */
function parseCsv(text) {
  const rows = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  const src = String(text || "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.length > 1 || record[0] !== "") rows.push(record);
      record = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    if (record.length > 1 || record[0] !== "") rows.push(record);
  }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] ?? "";
    return obj;
  });
}

/** Coerce a raw CSV string to number if it looks numeric, else return as-is. */
function num(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/**
 * Load + memoize the fixture. Strips FORBIDDEN_COLUMNS from every table so no code
 * path downstream can accidentally surface the validation aid.
 * @param {string} [dataDir]
 * @returns {Record<string, Array<object>>}
 */
const _cache = new Map();
function loadTables(dataDir = DEFAULT_DATA_DIR) {
  if (_cache.has(dataDir)) return _cache.get(dataDir);
  const files = {
    risk_snapshots: "scrm_risk_snapshots.csv",
    suppliers: "scrm_suppliers.csv",
    risk_registry: "scrm_risk_registry.csv",
    components: "scrm_components.csv",
    contracts: "scrm_contracts.csv",
    findings: "scrm_findings.csv",
  };
  const tables = {};
  for (const [name, file] of Object.entries(files)) {
    const p = path.join(dataDir, file);
    let raw = [];
    try {
      raw = parseCsv(fs.readFileSync(p, "utf8"));
    } catch (err) {
      // A missing optional table shouldn't crash the specialist — surface an empty
      // table and let tools report "no data" rather than throwing.
      raw = [];
    }
    tables[name] = raw.map((row) => {
      const clean = {};
      for (const [k, v] of Object.entries(row)) {
        if (FORBIDDEN_COLUMNS.has(k)) continue;
        clean[k] = v;
      }
      return clean;
    });
  }
  _cache.set(dataDir, tables);
  return tables;
}

/** Test seam: drop memoized tables (used by unit tests with a temp dir). */
function _clearCache() {
  _cache.clear();
}

module.exports = {
  parseCsv,
  num,
  loadTables,
  DEFAULT_DATA_DIR,
  FORBIDDEN_COLUMNS,
  _clearCache,
};
