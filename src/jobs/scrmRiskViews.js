/**
 * scrmRiskViews — map each SCRM KRI to its Tableau view, and render that view as
 * a PNG for the risk brief. The SCRM analog of vhaMetricViews.js.
 *
 * STATUS: the M2 publish shipped the six SCRM passthrough DATASOURCES (see
 * demo-data/scrm/publish/SCRM_MCP_DATASOURCES.json) but not yet a per-KRI
 * VIEWS workbook. Until a "SCRM Risk Views" workbook is published, KRI_VIEWS is
 * empty: riskView() returns null, so the brief attaches no chart/link for a KRI
 * and simply relies on the narrative. The moment such a workbook exists, fill
 * KRI_VIEWS with { viewId, contentUrl } per risk_category (probe with
 * list-views, workbookName filter — same recipe as vhaMetricViews) and nothing
 * else in the brief changes.
 *
 * PURE except fetchRiskViewImage(), which calls the Tableau MCP get-view-image
 * tool. Every failure is non-fatal — the text brief must still deliver.
 */

const {
  callTableauTool,
  extractImageBuffersFromMcpToolResult,
} = require("../assistant/tableauMcpClient");

// risk_category → the KRI's view in the (not-yet-published) SCRM Risk Views
// workbook. Empty until that workbook lands; see file header.
const KRI_VIEWS = {
  // FOCI: { viewId: "…", contentUrl: "SCRMRiskViews/sheets/FOCI" },
  // CYBER: { viewId: "…", contentUrl: "SCRMRiskViews/sheets/Cyber" },
  // …one per risk_category…
};

// Base for human-clickable view links. The MCP server URL is the API endpoint,
// not the pod's browse URL, so this is a separate, override-able constant.
const VIEW_LINK_BASE =
  process.env.SCRM_TABLEAU_VIEW_BASE ||
  "https://prod-useast-a.online.tableau.com/#/site/usfederaldemos/views";

const IMG_WIDTH = Number(process.env.SCRM_BRIEF_VIEW_WIDTH) || 1200;
const IMG_HEIGHT = Number(process.env.SCRM_BRIEF_VIEW_HEIGHT) || 800;

function riskView(riskCategory) {
  return KRI_VIEWS[riskCategory] || null;
}

/** Human-clickable Tableau Cloud view URL from a view's contentUrl. */
function viewDeepLink(contentUrl) {
  if (!contentUrl) return null;
  const path = String(contentUrl).replace("/sheets/", "/");
  return `${VIEW_LINK_BASE}/${path}`;
}

/**
 * Per-portfolio view filters. Views will default to program-wide today, so this
 * returns {} (no filter). When the KRI views gain a portfolio parameter, map
 * portfolioName → { "<Filter Field>": "<value>" } here and nothing else changes.
 */
function viewFiltersForPortfolio(_portfolioName) {
  return {};
}

/**
 * Render a KRI's view as a PNG. Returns an upload descriptor
 * { buffer, mimeType, filename, title, viewId } or null (unmapped KRI, no image,
 * or a tool error — all non-fatal for the brief).
 *
 * @param {string} riskCategory
 * @param {{ riskCaption?: string, portfolioName?: string, tableauMcpBaseUrl?: string }} [opts]
 */
async function fetchRiskViewImage(riskCategory, opts = {}) {
  const v = riskView(riskCategory);
  if (!v) return null;
  const viewFilters = viewFiltersForPortfolio(opts.portfolioName);
  const args = { viewId: v.viewId, width: IMG_WIDTH, height: IMG_HEIGHT, format: "PNG" };
  if (viewFilters && Object.keys(viewFilters).length) args.viewFilters = viewFilters;
  try {
    const { result } = await callTableauTool("get-view-image", args, {
      tableauMcpBaseUrl: opts.tableauMcpBaseUrl,
    });
    const images = extractImageBuffersFromMcpToolResult(result);
    const img = images[0];
    if (!img || !img.buffer?.length) return null;
    const caption = opts.riskCaption || riskCategory;
    return {
      buffer: img.buffer,
      mimeType: img.mimeType || "image/png",
      filename: `${riskCategory}.png`,
      title: `${caption} — ${opts.portfolioName || "Program Office"}`,
      viewId: v.viewId,
    };
  } catch (err) {
    console.error(`[scrm-brief] get-view-image failed for ${riskCategory} (${v.viewId}): ${err?.message || err}`);
    return null;
  }
}

module.exports = {
  KRI_VIEWS,
  riskView,
  viewDeepLink,
  viewFiltersForPortfolio,
  fetchRiskViewImage,
};
