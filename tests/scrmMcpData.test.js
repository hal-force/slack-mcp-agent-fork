const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  canonKey,
  resolveDatasourceMap,
  parseVdsData,
  parseMetadataCaptions,
  buildCaptionResolver,
  fetchTable,
  loadTablesFromMcp,
  makeMcpDispatchTool,
  TABLE_COLUMNS,
  TABLE_NAMES,
} = require("../src/agents/scrmMcpData");

// ── helpers ────────────────────────────────────────────────────────────────
const wrap = (obj) => ({ text: JSON.stringify(obj) });
// Turn a canonical column name into a Tableau-style Title Case caption
// ("snapshot_date" → "Snapshot Date") to prove caption↔canonical resolution.
const titleCase = (col) => col.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/**
 * Build a mock MCP callTool that serves one table: metadata returns Tableau-v4
 * fieldGroups captions (Title Cased), query returns the given rows keyed by those
 * same captions. Records every query's requested fields for assertions.
 */
function mockCallToolFor(canonicalColumns, canonicalRows, opts = {}) {
  const captions = (opts.captions || canonicalColumns.filter((c) => !(opts.dropCaptions || []).includes(c))).map(titleCase);
  const captured = { queries: [] };
  const callTool = async (name, input) => {
    if (name === "get-datasource-metadata") {
      return wrap({ fieldGroups: [{ fields: captions.map((c) => ({ fieldCaption: c })) }] });
    }
    if (name === "query-datasource") {
      captured.queries.push(input);
      const rows = canonicalRows.map((r) => {
        const out = {};
        for (const [col, v] of Object.entries(r)) out[titleCase(col)] = v; // key by caption
        return out;
      });
      return wrap({ data: rows });
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return { callTool, captured };
}

test("canonKey normalizes case and separators", () => {
  assert.equal(canonKey("Snapshot Date"), "snapshotdate");
  assert.equal(canonKey("snapshot_date"), "snapshotdate");
  assert.equal(canonKey("FOCI_flag"), "fociflag");
  assert.equal(canonKey(null), "");
});

test("parseVdsData reads {data:[]}, bare arrays, and tolerates junk", () => {
  assert.deepEqual(parseVdsData(JSON.stringify({ data: [{ a: 1 }] })), [{ a: 1 }]);
  assert.deepEqual(parseVdsData(JSON.stringify([{ b: 2 }])), [{ b: 2 }]);
  assert.deepEqual(parseVdsData(""), []);
  assert.deepEqual(parseVdsData("not json"), []);
  assert.deepEqual(parseVdsData(JSON.stringify({ nope: 1 })), []);
});

test("parseMetadataCaptions handles the Tableau v4 fieldGroups shape", () => {
  const v4 = JSON.stringify({
    fieldGroups: [
      { fields: [{ fieldCaption: "Supplier Key" }, { fieldCaption: "Risk Score" }] },
      { fields: [{ fieldCaption: "Foci Flag" }] },
    ],
  });
  assert.deepEqual(parseMetadataCaptions(v4), ["Supplier Key", "Risk Score", "Foci Flag"]);
});

test("parseMetadataCaptions handles flat shapes, string entries, and empties", () => {
  assert.deepEqual(parseMetadataCaptions(JSON.stringify({ fields: [{ name: "A" }, { caption: "B" }] })), ["A", "B"]);
  assert.deepEqual(parseMetadataCaptions(JSON.stringify({ columns: ["X", "Y"] })), ["X", "Y"]);
  assert.deepEqual(parseMetadataCaptions(JSON.stringify(["P", "Q"])), ["P", "Q"]);
  assert.deepEqual(parseMetadataCaptions(""), []);
  assert.deepEqual(parseMetadataCaptions("junk"), []);
});

test("buildCaptionResolver maps canonical→caption, skips forbidden, falls back when no metadata", () => {
  const cols = ["supplier_key", "risk_score", "composite_risk_pct"];
  const caps = ["Supplier Key", "Risk Score", "Composite Risk Pct"];
  const r = buildCaptionResolver(cols, caps);
  assert.equal(r.get("supplier_key"), "Supplier Key");
  assert.equal(r.get("risk_score"), "Risk Score");
  assert.ok(!r.has("composite_risk_pct"), "forbidden column is never requested");

  // No metadata → assume caption == canonical column name (Hyper case).
  const r2 = buildCaptionResolver(["supplier_key", "risk_score"], []);
  assert.equal(r2.get("supplier_key"), "supplier_key");
  assert.equal(r2.get("risk_score"), "risk_score");
});

test("resolveDatasourceMap: explicit wins; env JSON parsed; junk → {}", () => {
  assert.deepEqual(resolveDatasourceMap({ suppliers: "L1" }), { suppliers: "L1" });

  const saved = process.env.SCRM_MCP_DATASOURCES;
  try {
    process.env.SCRM_MCP_DATASOURCES = JSON.stringify({ risk_snapshots: "ENV-LUID" });
    assert.deepEqual(resolveDatasourceMap(), { risk_snapshots: "ENV-LUID" });

    process.env.SCRM_MCP_DATASOURCES = "{not valid json";
    assert.deepEqual(resolveDatasourceMap(), {});

    delete process.env.SCRM_MCP_DATASOURCES;
    assert.deepEqual(resolveDatasourceMap(), {});
  } finally {
    if (saved === undefined) delete process.env.SCRM_MCP_DATASOURCES;
    else process.env.SCRM_MCP_DATASOURCES = saved;
  }
});

test("fetchTable re-keys captions→canonical, stringifies values, and requests dimensions only", async () => {
  const cols = TABLE_COLUMNS.risk_snapshots;
  const rows = [
    { snapshot_date: "2026-08-31", supplier_key: "SUP-001", risk_category: "CYBER", risk_score: 70.1, foci_flag: true },
    { snapshot_date: "2026-08-31", supplier_key: "SUP-002", risk_category: "CYBER", risk_score: 30.8, foci_flag: false },
  ];
  const { callTool, captured } = mockCallToolFor(cols, rows);
  const out = await fetchTable({ table: "risk_snapshots", luid: "LUID-1", callTool });

  assert.equal(out.length, 2);
  // Re-keyed to canonical snake_case and stringified (numbers + booleans → strings).
  assert.deepEqual(out[0], { snapshot_date: "2026-08-31", supplier_key: "SUP-001", risk_category: "CYBER", risk_score: "70.1", foci_flag: "true" });
  assert.equal(out[1].risk_score, "30.8");
  assert.equal(out[1].foci_flag, "false");

  // The query requested resolved fields as dimensions (fieldCaption entries), no aggregation.
  assert.equal(captured.queries.length, 1);
  const fields = captured.queries[0].query.fields;
  assert.ok(Array.isArray(fields) && fields.length > 0);
  assert.ok(fields.every((f) => typeof f.fieldCaption === "string" && !("function" in f)), "dimension-only fields");
});

test("fetchTable strips composite_risk_pct even if the source leaks it", async () => {
  const cols = TABLE_COLUMNS.suppliers; // curated list already omits composite_risk_pct
  // Source returns a stray composite column; it must be dropped on read (belt-and-suspenders).
  const rows = [{ supplier_key: "SUP-001", sector: "Semiconductors", composite_risk_pct: 88.2 }];
  const { callTool } = mockCallToolFor(cols.concat(["composite_risk_pct"]), rows, {
    captions: cols.concat(["composite_risk_pct"]),
  });
  const out = await fetchTable({ table: "suppliers", luid: "LUID-S", callTool });
  assert.equal(out.length, 1);
  assert.ok(!("composite_risk_pct" in out[0]), "composite_risk_pct must never survive fetch");
  assert.equal(out[0].supplier_key, "SUP-001");
});

test("fetchTable returns [] when nothing resolves (all captions unknown)", async () => {
  const callTool = async (name) =>
    name === "get-datasource-metadata" ? wrap({ fieldGroups: [{ fields: [{ fieldCaption: "Totally Unrelated" }] }] }) : wrap({ data: [] });
  const out = await fetchTable({ table: "contracts", luid: "L", callTool });
  assert.deepEqual(out, []);
});

test("loadTablesFromMcp fetches every mapped table and leaves unmapped ones empty", async () => {
  const perTableCalls = [];
  const callTool = async (name, input) => {
    if (name === "get-datasource-metadata") {
      perTableCalls.push(input.datasourceLuid);
      // Serve a minimal set of captions keyed off the LUID's table.
      const table = { "L-snap": "risk_snapshots", "L-sup": "suppliers" }[input.datasourceLuid];
      const caps = (TABLE_COLUMNS[table] || []).map(titleCase);
      return wrap({ fieldGroups: [{ fields: caps.map((c) => ({ fieldCaption: c })) }] });
    }
    return wrap({ data: [] });
  };
  const tables = await loadTablesFromMcp({ datasources: { risk_snapshots: "L-snap", suppliers: "L-sup" }, callTool });

  // Every declared table key is present (parity with CSV loadTables).
  for (const t of TABLE_NAMES) assert.ok(t in tables, `${t} key present`);
  // Unmapped tables are empty arrays, not missing.
  assert.deepEqual(tables.findings, []);
  assert.deepEqual(tables.contracts, []);
  // Only the two mapped datasources were queried for metadata.
  assert.deepEqual(perTableCalls.sort(), ["L-snap", "L-sup"]);
});

test("makeMcpDispatchTool caches tables across calls (fetch once per specialist turn)", async () => {
  let metadataCalls = 0;
  const cols = TABLE_COLUMNS.suppliers;
  const rows = [{ supplier_key: "SUP-001", supplier_name: "Meridian Microelectronics", sector: "Semiconductors" }];
  const callTool = async (name, input) => {
    if (name === "get-datasource-metadata") {
      metadataCalls++;
      return wrap({ fieldGroups: [{ fields: cols.map((c) => ({ fieldCaption: titleCase(c) })) }] });
    }
    return wrap({ data: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [titleCase(k), v]))) });
  };

  const dispatch = makeMcpDispatchTool({ datasources: { suppliers: "L-sup" }, callTool });
  const a = await dispatch("scrm_query", { table: "suppliers", measures: [{ agg: "count" }] });
  const b = await dispatch("scrm_query", { table: "suppliers", group_by: ["sector"], measures: [{ agg: "count" }] });

  assert.ok(!a.error, JSON.stringify(a));
  assert.ok(!b.error, JSON.stringify(b));
  // Tables were loaded exactly once (one metadata round-trip for the single mapped table),
  // then reused for the second dispatch — no re-fetch.
  assert.equal(metadataCalls, 1, "tables fetched once and cached for the turn");
});
