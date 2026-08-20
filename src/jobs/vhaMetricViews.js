/**
 * vhaMetricViews — map each VHA registry metric to its Tableau view, and render
 * that view as a PNG for the daily brief.
 *
 * The workbook "VHA Metrics Views and Dashboards" (project "VA | Veterans
 * Affairs", site usfederaldemos) has one "Metric Target Select - <metric>" sheet
 * per metric. We attach the matching sheet's image to each flagged-metric section
 * of a user's brief so the "so-what" prose is backed by the actual chart.
 *
 * The views currently default to Phoenix. As other facilities come online they'll
 * be parameterized by a facility field; viewFiltersForFacility() is the single
 * hook to fill in then (get-view-image accepts a viewFilters map), so the brief
 * code does not change.
 *
 * PURE except fetchMetricViewImage(), which calls the Tableau MCP get-view-image
 * tool. All fetches are sequential elsewhere (single shared PAT on the MCP http
 * transport) and every failure is non-fatal — the text brief must still deliver.
 */

const {
  callTableauTool,
  extractImageBuffersFromMcpToolResult,
} = require("../assistant/tableauMcpClient");

// metric_key → the "Metric Target Select - <metric>" view in the workbook.
// ids + contentUrls probed live from list-views (workbookName filter). The two
// generic sheets (Date Focus, Sparkline) are intentionally unmapped — the brief
// wants the per-metric selector, not a generic frame.
const METRIC_VIEWS = {
  SMR30: { viewId: "8715fec9-c44f-449d-8efd-e84310ce84b0", contentUrl: "VHAMetricsViewsandDashboards/sheets/MetricTargetSelect-SMR30" },
  READMIT30: { viewId: "fbec6f26-5762-4149-a516-bfb989f62658", contentUrl: "VHAMetricsViewsandDashboards/sheets/MetricTargetSelect-READMIT30" },
  OMELOS: { viewId: "bc5700e7-808b-472d-a28d-cd0e7c34dd8a", contentUrl: "VHAMetricsViewsandDashboards/sheets/MetricTargetSelect-OMELOS" },
  RVU_UNUSED: { viewId: "39c50ad2-0ed5-474f-81a8-1865e98f0f46", contentUrl: "VHAMetricsViewsandDashboards/sheets/MetricTargetSelect-RVUUnused" },
  PHA_REFERRAL: { viewId: "96b0a7c8-74e1-4e55-a8f2-e93e03b09769", contentUrl: "VHAMetricsViewsandDashboards/sheets/MetricTargetSelect-PHAReferral" },
  SHEP_EXP: { viewId: "ca8c1bce-e36a-42bc-9758-b6b882b99fa7", contentUrl: "VHAMetricsViewsandDashboards/sheets/MetricTargetSelect-SHEPEXP" },
};

// Base for human-clickable view links. The MCP server URL is the API endpoint,
// not the pod's browse URL, so this is a separate, override-able constant.
const VIEW_LINK_BASE =
  process.env.VHA_TABLEAU_VIEW_BASE ||
  "https://prod-useast-a.online.tableau.com/#/site/usfederaldemos/views";

const IMG_WIDTH = Number(process.env.VHA_BRIEF_VIEW_WIDTH) || 1200;
const IMG_HEIGHT = Number(process.env.VHA_BRIEF_VIEW_HEIGHT) || 800;

function metricView(metricKey) {
  return METRIC_VIEWS[metricKey] || null;
}

/** Human-clickable Tableau Cloud view URL from a view's contentUrl. */
function viewDeepLink(contentUrl) {
  if (!contentUrl) return null;
  // contentUrl is "<workbook>/sheets/<view>"; the browse path drops "/sheets".
  const path = String(contentUrl).replace("/sheets/", "/");
  return `${VIEW_LINK_BASE}/${path}`;
}

/**
 * Per-facility view filters. Views default to Phoenix today, so this returns {}
 * (no filter) for every facility. When the views gain a facility parameter, map
 * facilityName → { "<Filter Field>": "<facility value>" } here and nothing else
 * changes. get-view-image forwards the map as viewFilters.
 */
function viewFiltersForFacility(_facilityName) {
  return {};
}

/**
 * Render a metric's view as a PNG. Returns an upload descriptor
 * { buffer, mimeType, filename, title, viewId } or null (unmapped metric, no
 * image in the result, or a tool error — all non-fatal for the brief).
 *
 * @param {string} metricKey
 * @param {{ metricCaption?: string, facilityName?: string, tableauMcpBaseUrl?: string }} [opts]
 */
async function fetchMetricViewImage(metricKey, opts = {}) {
  const v = metricView(metricKey);
  if (!v) return null;
  const viewFilters = viewFiltersForFacility(opts.facilityName);
  const args = { viewId: v.viewId, width: IMG_WIDTH, height: IMG_HEIGHT, format: "PNG" };
  if (viewFilters && Object.keys(viewFilters).length) args.viewFilters = viewFilters;
  try {
    const { result } = await callTableauTool("get-view-image", args, {
      tableauMcpBaseUrl: opts.tableauMcpBaseUrl,
    });
    const images = extractImageBuffersFromMcpToolResult(result);
    const img = images[0];
    if (!img || !img.buffer?.length) return null;
    const caption = opts.metricCaption || metricKey;
    return {
      buffer: img.buffer,
      mimeType: img.mimeType || "image/png",
      filename: `${metricKey}.png`,
      title: `${caption} — ${opts.facilityName || "VHA"}`,
      viewId: v.viewId,
    };
  } catch (err) {
    console.error(`[vha-brief] get-view-image failed for ${metricKey} (${v.viewId}): ${err?.message || err}`);
    return null;
  }
}

module.exports = {
  METRIC_VIEWS,
  metricView,
  viewDeepLink,
  viewFiltersForFacility,
  fetchMetricViewImage,
};
