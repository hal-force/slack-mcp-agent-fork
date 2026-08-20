/**
 * triageData — the local fixture backend for the triage specialist's tools.
 *
 * The triage specialist reasons over the synthetic hospital dataset in
 * `demo-data/triage/out/`. For M2/M3 this data is read directly from the bundled
 * CSVs so the eval is deterministic and runs offline. At M4 the SAME tool surface
 * (src/agents/triageTools.js) is repointed at the published Tableau datasources
 * via the MCP — this module is the piece that gets swapped, not the tools or the
 * specialist prompt.
 *
 * ── The answer-key invariant ──────────────────────────────────────────────
 * This module reads ONLY from `demo-data/triage/out/` (agent-facing data). It
 * must NEVER read anything under `tests/eval/triage/` (GROUND_TRUTH.md,
 * manifest.json, the fixture BRIEF/README). Doing so would hand the agent the
 * planted-effect magnitudes it is supposed to discover. It also refuses to expose
 * `patients.mean_skill_match_pct` (a validation aid; see the fixture README) so
 * the agent can't read the skill-match effect off a circular derived column.
 *
 * Everything here is standard-library only (no CSV dependency) — the fixture's
 * own constraint, mirrored on the consuming side.
 */

const fs = require("fs");
const path = require("path");

// Agent-facing data dir. Overridable for tests, but defaults to the bundled
// fixture. Deliberately NOT configurable to point anywhere near tests/eval.
const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "demo-data", "triage", "out");

// Column excluded from every agent-facing table: it is the outcome model's own
// input, exposed only for offline validation. Reading the skill-match→outcome
// effect off this column is the tautology the fixture explicitly warns about.
const FORBIDDEN_COLUMNS = new Set(["mean_skill_match_pct"]);

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
 * embedded newlines, and doubled "" escapes. Returns an array of row objects
 * keyed by the header row. Standard-library only.
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
      // Swallow \r\n as one break; ignore blank line artifacts.
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      // Skip fully-empty trailing records.
      if (record.length > 1 || record[0] !== "") rows.push(record);
      record = [];
    } else {
      field += c;
    }
  }
  // Final field/record (no trailing newline).
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
 * Load + memoize the fixture. Strips FORBIDDEN_COLUMNS from every table so no
 * code path downstream can accidentally surface a validation aid.
 * @param {string} [dataDir]
 * @returns {Record<string, Array<object>>}
 */
const _cache = new Map();
function loadTables(dataDir = DEFAULT_DATA_DIR) {
  if (_cache.has(dataDir)) return _cache.get(dataDir);
  const files = {
    patients: "patients.csv",
    nurses: "nurses.csv",
    nurse_skills: "nurse_skills.csv",
    patient_required_skills: "patient_required_skills.csv",
    assignments: "assignments.csv",
    unit_snapshots: "unit_snapshots.csv",
    clinical_notes: "clinical_notes.csv",
    skills_reference: "skills_reference.csv",
  };
  const tables = {};
  for (const [name, file] of Object.entries(files)) {
    const p = path.join(dataDir, file);
    let raw = [];
    try {
      raw = parseCsv(fs.readFileSync(p, "utf8"));
    } catch (err) {
      // A missing optional table shouldn't crash the specialist — surface an
      // empty table and let tools report "no data" rather than throwing.
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
