const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseDatasourceCatalog,
  rankDatasourcesForMessage,
  formatDatasourceCatalogCompact,
} = require("../src/assistant/tableauContextBuilder");

// ---- REGRESSION: Tableau MCP v4 list-datasources shape ----
// v4 returns { "data": [ ...rows ], "totalAvailable": N } where `data` IS the
// row array. The parser previously checked j.datasources / j.dataSources /
// j.data?.datasources / j.items — none of which match, so the ENTIRE catalog
// parsed to 0 rows. With an empty catalog, pickDatasourceForMessage never
// matched, no field metadata auto-loaded, and the raw ~120KB JSON blob was
// dumped into the model context instead. This was the true cause of the agent
// "not finding" OTF Grants Enriched even though it was published.
test("REGRESSION: parses Tableau MCP v4 { data: [...] } list-datasources shape", () => {
  const v4 = JSON.stringify({
    data: [
      {
        id: "65ee6d6a-6541-43ee-abef-cd6a5027c1d7",
        name: "Superstore Datasource",
        contentUrl: "SuperstoreDatasource",
        project: { id: "e807", name: "Z-Samples" },
      },
      {
        id: "03467bb1-735b-4f02-b88e-983a74fd0549",
        name: "OTF Grants Enriched",
        contentUrl: "OTFGrantsEnriched",
        project: { id: "abcd", name: "Grants" },
      },
    ],
    totalAvailable: 223,
  });
  const catalog = parseDatasourceCatalog("Published data sources (sample):\n" + v4);
  assert.equal(catalog.length, 2, "should parse both v4 rows");
  const otf = catalog.find((r) => /OTF Grants Enriched/i.test(r.name));
  assert.ok(otf, "OTF Grants Enriched should be present in the parsed catalog");
  assert.equal(otf.luid, "03467bb1-735b-4f02-b88e-983a74fd0549");
  assert.equal(otf.project, "Grants", "project name should be lifted from project.name");
});

test("still parses the legacy { datasources: [...] } shape", () => {
  const legacy = JSON.stringify({
    datasources: [
      { luid: "aaaa1111-0000-0000-0000-000000000000", name: "Legacy DS" },
    ],
  });
  const catalog = parseDatasourceCatalog("Published data sources (sample):\n" + legacy);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].name, "Legacy DS");
});

test("still parses the nested { data: { datasources: [...] } } shape", () => {
  const nested = JSON.stringify({
    data: { datasources: [{ id: "bbbb2222-0000-0000-0000-000000000000", name: "Nested DS" }] },
  });
  const catalog = parseDatasourceCatalog("Published data sources (sample):\n" + nested);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].name, "Nested DS");
});

// ---- Matcher: the user's phrasing must rank OTF first ----
// Given a correctly-parsed catalog, "find my OTF grants data" must rank
// "OTF Grants Enriched" as the top candidate so its field metadata auto-loads.
test("ranks 'OTF Grants Enriched' first for OTF-grants phrasings", () => {
  const catalog = [
    { luid: "1", name: "OTF Grants Enriched", project: "Grants", matchHints: [] },
    { luid: "2", name: "Grants Data - SLED", project: "Grants", matchHints: [] },
    { luid: "3", name: "Pulse Grants", project: "Grants", matchHints: [] },
    { luid: "4", name: "Superstore Datasource", project: "Z-Samples", matchHints: [] },
  ];
  for (const msg of [
    "Can you find my OTF grants data for me?",
    "OTF grants",
    "show me OTF Grants Enriched",
    "summarize the OTF Grants Enriched datasource",
  ]) {
    const ranked = rankDatasourcesForMessage(msg, catalog);
    assert.ok(ranked.length > 0, `"${msg}" should produce ranked candidates`);
    assert.match(ranked[0].row.name, /OTF Grants Enriched/i, `"${msg}" should rank OTF first`);
  }
});

// ---- Compact catalog rendering (token-bloat optimization) ----
// The raw list-datasources JSON is ~30k tokens for a few hundred rows. The
// compact form is one line per row (name — project — luid) and must stay far
// smaller while still naming every datasource so the model can pick one.
test("formatDatasourceCatalogCompact renders one line per row, name + luid", () => {
  const catalog = [
    { luid: "aaaa", name: "OTF Grants Enriched", project: "Grants" },
    { luid: "bbbb", name: "Superstore Datasource", project: "Z-Samples" },
    { luid: "cccc", name: "No Project DS" },
  ];
  const out = formatDatasourceCatalogCompact(catalog);
  assert.match(out, /3 total/);
  assert.match(out, /OTF Grants Enriched — Grants — `aaaa`/);
  assert.match(out, /Superstore Datasource — Z-Samples — `bbbb`/);
  assert.match(out, /No Project DS — `cccc`/); // no project → no dangling dash
  assert.equal(out.split("\n").length, 4); // header + 3 rows
});

test("formatDatasourceCatalogCompact is far smaller than raw JSON, and empty on empty", () => {
  assert.equal(formatDatasourceCatalogCompact([]), "");
  const big = Array.from({ length: 200 }, (_, i) => ({
    luid: `luid-${i}`,
    name: `Datasource number ${i}`,
    project: "SomeProject",
  }));
  const raw = JSON.stringify({ data: big, totalAvailable: 200 });
  const compact = formatDatasourceCatalogCompact(big);
  assert.ok(compact.length < raw.length, "compact should be smaller than raw JSON");
});

test("formatDatasourceCatalogCompact caps rows and notes the remainder", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ luid: `l${i}`, name: `DS ${i}` }));
  const out = formatDatasourceCatalogCompact(many, 5);
  assert.match(out, /…\(7 more not shown\)/);
});
