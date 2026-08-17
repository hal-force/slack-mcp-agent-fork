/**
 * Synthetic Tableau datasource catalogs for context-rot simulation.
 *
 * Produces a list-datasources payload in the real Tableau MCP v4 shape
 * ({ data: [rows], totalAvailable }) with N decoy datasources and one known
 * target buried inside. Lets the context-rot monitor answer: "as this site
 * grows to N datasources, does our target still rank #1 and still fit in the
 * catalog the model sees?" — without touching a live server.
 *
 * Deterministic: no Math.random(), so results are reproducible in CI.
 */

const TARGET = {
  id: "03467bb1-735b-4f02-b88e-983a74fd0549",
  name: "OTF Grants Enriched",
  contentUrl: "OTFGrantsEnriched",
  project: { id: "grants-proj", name: "Grants" },
};

// Decoy names drawn from a fixed pool so some share tokens with the target
// ("grants", "enriched") — a realistic adversarial catalog where near-collisions
// compete with the target for the top rank.
const DECOY_STEMS = [
  "Sales Pipeline",
  "Customer 360 Enriched",
  "Finance Ledger",
  "HR Headcount",
  "Grants Summary",
  "Program Budget",
  "Supply Chain Risk",
  "Marketing Attribution",
  "Support Tickets",
  "Inventory Levels",
  "Grant Applications Raw",
  "Enriched Vendor Master",
];

/**
 * Build a list-datasources JSON string with `n` total rows, the target buried
 * at `targetIndex` (default: middle). Returns the raw text a real MCP
 * list-datasources call would return, wrapped in the "sample" prose prefix the
 * app's tryListDatasources adds (so parseDatasourceCatalog is exercised
 * end-to-end).
 *
 * @param {number} n - total datasource count to simulate
 * @param {{ includeTarget?: boolean, targetIndex?: number }} [opts]
 * @returns {{ listText: string, target: {name:string, luid:string} }}
 */
function buildCatalogListText(n, opts = {}) {
  const includeTarget = opts.includeTarget !== false;
  const rows = [];
  const decoyCount = includeTarget ? Math.max(0, n - 1) : n;

  for (let i = 0; i < decoyCount; i++) {
    const stem = DECOY_STEMS[i % DECOY_STEMS.length];
    rows.push({
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      name: `${stem} ${Math.floor(i / DECOY_STEMS.length) + 1}`,
      contentUrl: `${stem.replace(/\s+/g, "")}${i}`,
      project: { id: `p${i % 25}`, name: `Project ${i % 25}` },
    });
  }

  if (includeTarget) {
    const at = Number.isInteger(opts.targetIndex)
      ? Math.max(0, Math.min(opts.targetIndex, rows.length))
      : Math.floor(rows.length / 2);
    rows.splice(at, 0, TARGET);
  }

  const payload = JSON.stringify({ data: rows, totalAvailable: rows.length });
  return {
    listText: `Published data sources (sample):\n${payload}`,
    target: { name: TARGET.name, luid: TARGET.id },
  };
}

module.exports = { buildCatalogListText, TARGET, DECOY_STEMS };
