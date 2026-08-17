const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  TABLEAU_TOOL_SPECS,
  datasourceListWarning,
} = require("../src/assistant/tableauGeminiTools");

// ---- Regression: silent datasource-discovery truncation ----
// The federal Tableau server hosts 223 data sources but every MCP tool result
// is capped (TABLEAU_MCP_MAX_RESULT_CHARS, default 32000). An unfiltered
// list-datasources call was returning a partial/truncated catalog that OMITTED
// the authoritative "OTF Grants Enriched" source, so the agent silently
// grounded grant answers in a secondary dataset. The fix: expose a `filter`
// param (name:eq:*Grant*) AND warn whenever an unfiltered list is incomplete.

test("list-datasources tool spec advertises a filter param", () => {
  const spec = TABLEAU_TOOL_SPECS.find((s) => s.name === "tableau_list_datasources");
  assert.ok(spec, "tableau_list_datasources spec must exist");
  assert.ok(spec.inputSchema.properties.filter, "spec must expose a `filter` property");
  assert.match(
    spec.inputSchema.properties.filter.description,
    /name:eq/i,
    "filter description should show the Tableau REST name filter syntax",
  );
});

test("no warning when the caller filtered (already narrowed)", () => {
  const raw = JSON.stringify({ data: [{ id: "a", name: "OTF Grants Enriched" }] });
  const w = datasourceListWarning({ rawText: raw, filter: "name:eq:*Grant*", limit: 50 });
  assert.equal(w, null);
});

test("warns when an unfiltered list is TRUNCATED (cut mid-JSON)", () => {
  // Simulate a body longer than the cap that fails to JSON.parse (truncated).
  const big = '{"data":[' + '{"id":"x","name":"DS"},'.repeat(3000); // no closing bracket
  const w = datasourceListWarning({ rawText: big, filter: "", limit: 250, maxChars: 32000 });
  assert.ok(w, "a truncated unfiltered list must warn");
  assert.match(w, /TRUNCATED/);
  assert.match(w, /filter/i);
});

test("warns when an unfiltered list hits its row ceiling (more exist)", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: "DS" + i }));
  const raw = JSON.stringify({ data: rows, totalAvailable: 223 });
  const w = datasourceListWarning({ rawText: raw, filter: "", limit: 50 });
  assert.ok(w, "a full-to-the-limit unfiltered list must warn");
  assert.match(w, /PARTIAL/);
  assert.match(w, /50 data sources/);
});

test("no warning when an unfiltered list is comfortably under the limit", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: String(i), name: "DS" + i }));
  const raw = JSON.stringify({ data: rows });
  const w = datasourceListWarning({ rawText: raw, filter: "", limit: 50 });
  assert.equal(w, null, "a short complete list should not warn");
});
