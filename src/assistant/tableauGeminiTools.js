/**
 * Gemini function declarations + dispatch for Tableau MCP (query, list, metadata).
 */

const { FunctionDeclarationSchemaType } = require("@google-cloud/vertexai");
const {
  callTableauTool,
  resolveTableauMcpUrl,
  getDatasourceListLimit,
  extractImageBuffersFromMcpToolResult,
  mergeDatasourceUrlsFromListText,
  mergeViewUrlsFromListText,
  extensionForMime,
} = require("./tableauMcpClient");
const { coerceTableauMcpQueryInput, normalizeVizqlQueryObject } = require("./vizqlNormalize");

const T = FunctionDeclarationSchemaType;

const TABLEAU_GEMINI_TOOL_NAMES = new Set([
  "tableau_query_datasource",
  "tableau_list_datasources",
  "tableau_get_datasource_metadata",
  "tableau_list_views",
  "tableau_get_view_image",
]);

function isTableauGeminiTool(name) {
  return TABLEAU_GEMINI_TOOL_NAMES.has(name);
}

const TABLEAU_FUNCTION_DECLARATIONS = [
  {
    name: "tableau_list_datasources",
    description:
      "List published Tableau data sources from the connected MCP server. Use when the user asks what sources exist or you need a datasource_luid for metadata/query.",
    parameters: {
      type: T.OBJECT,
      properties: {
        limit: {
          type: T.NUMBER,
          description:
            "Max sources to return. If omitted, uses TABLEAU_MCP_DATASOURCE_LIST_LIMIT or defaults to 50; the agent does not impose a maximum on values you pass here.",
        },
      },
    },
  },
  {
    name: "tableau_get_datasource_metadata",
    description:
      "Fetch field/column metadata for one published data source. Call before building a query so field captions and types match the server.",
    parameters: {
      type: T.OBJECT,
      properties: {
        datasource_luid: {
          type: T.STRING,
          description: "Data source LUID (UUID from list or Tableau context).",
        },
      },
      required: ["datasource_luid"],
    },
  },
  {
    name: "tableau_list_views",
    description:
      "List Tableau views (MCP list-views). **Required step before get_view_image** when the user wants charts, revenue, trends, or dashboard-style answers. Use **filter** to narrow (Tableau REST: e.g. name:eq:Overview, name:eq:*Sales*, workbookName:eq:*Superstore*). Then pass a view **id** from the results to tableau_get_view_image.",
    parameters: {
      type: T.OBJECT,
      properties: {
        filter: {
          type: T.STRING,
          description:
            "Strongly recommended. Tableau REST filter on views (e.g. name:eq:Overview, name:eq:*Profit*, workbookName:eq:*Superstore* where wildcards are supported). Reduces noise before picking a view_id for get_view_image.",
        },
        page_size: {
          type: T.NUMBER,
          description: "Optional page size for pagination (MCP pageSize).",
        },
        limit: {
          type: T.NUMBER,
          description: "Max views to return (default 200).",
        },
      },
    },
  },
  {
    name: "tableau_get_view_image",
    description:
      "Render a **PNG** snapshot of a published view (MCP get-view-image). **view_id** comes from tableau_list_views. Default to **format PNG**, **width 1400**, **height 900** for Slack readability (or 1200×800). Slack uploads the file under the bot message automatically—tell the user the screenshot is below. Use for revenue/trend/dashboard questions, not only when the user says 'screenshot'.",
    parameters: {
      type: T.OBJECT,
      properties: {
        view_id: {
          type: T.STRING,
          description: "View UUID from list-views (same as MCP viewId).",
        },
        width: { type: T.NUMBER, description: "Optional image width in pixels." },
        height: { type: T.NUMBER, description: "Optional image height in pixels." },
        format: {
          type: T.STRING,
          description: "PNG (default) or SVG where the server supports it.",
          enum: ["PNG", "SVG"],
        },
      },
      required: ["view_id"],
    },
  },
  {
    name: "tableau_query_datasource",
    description:
      "Run a VizQL query via Tableau MCP tool query-datasource (same contract as Claude Desktop + Tableau MCP). The MCP server expects top-level datasourceLuid + query + optional limit. Inside query, each field MUST use fieldCaption exactly as shown in get-datasource-metadata (e.g. captions with |). For measures use function: SUM|AVG|COUNT|MEDIAN|MAX|MIN. Prefer a small fields list first; add filters using field: { fieldCaption: \"...\" } and filterType per VizQL Data Service docs. Do not use SQL or raw column names unless they match captions.",
    parameters: {
      type: T.OBJECT,
      properties: {
        datasource_luid: {
          type: T.STRING,
          description:
            "Target data source LUID. Required unless query_json embeds a VDS-style body with datasource.datasourceLuid.",
        },
        query_json: {
          type: T.STRING,
          description:
            "Stringified JSON: either the inner query only { \"fields\": [...], \"filters\": [...] } or a full VDS-shaped object { \"datasource\": { \"datasourceLuid\": \"...\" }, \"query\": { ... } }. Field entries use fieldCaption (not name). Example field: { \"fieldCaption\": \"Sales\", \"function\": \"SUM\" }.",
        },
        limit: {
          type: T.NUMBER,
          description: "Optional max rows for the MCP query-datasource tool (e.g. 500–2000 for summaries).",
        },
      },
      required: ["query_json"],
    },
  },
];

const MAX_TOOL_TEXT_CHARS = Number(process.env.TABLEAU_MCP_MAX_RESULT_CHARS || 32000);

/**
 * Walk JSON for Tableau browse URLs (avoids grabbing arbitrary https cells in data grids).
 * @param {unknown} obj
 * @param {number} depth
 * @returns {string}
 */
function findKeyedBrowseUrlInJson(obj, depth = 0) {
  if (depth > 14 || obj == null) return "";
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const u = findKeyedBrowseUrlInJson(item, depth + 1);
      if (u) return u;
    }
    return "";
  }
  if (typeof obj === "object") {
    const keys = ["webpageUrl", "webpage_url", "contentUrl", "content_url"];
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return v.trim();
    }
    for (const v of Object.values(obj)) {
      if (v != null && typeof v === "object") {
        const u = findKeyedBrowseUrlInJson(v, depth + 1);
        if (u) return u;
      }
    }
  }
  return "";
}

/**
 * @param {string} text - MCP tool body (JSON or text containing JSON keys)
 * @returns {string}
 */
function tryExtractBrowseUrlFromToolText(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  try {
    const j = JSON.parse(s);
    const u = findKeyedBrowseUrlInJson(j);
    if (u) return u;
  } catch (_) {
    // fall through
  }
  for (const key of ["webpageUrl", "webpage_url", "contentUrl", "content_url"]) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i");
    const m = s.match(re);
    if (m) {
      const inner = m[1].replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\");
      if (/^https?:\/\//i.test(inner)) return inner.trim();
    }
  }
  return "";
}

/**
 * Optional env: browse URL template with literal `{luid}` replaced by datasource LUID (site-specific).
 * Example (illustrative): https://my-server/#/site/MySite/datasources/{luid}
 * @param {string} luid
 * @returns {string}
 */
function datasourceBrowseUrlFromEnvTemplate(luid) {
  const tpl = (process.env.TABLEAU_DATASOURCE_BROWSE_URL_TEMPLATE || "").trim();
  if (!tpl || !luid || !/\{luid\}/i.test(tpl)) return "";
  return tpl.replace(/\{luid\}/gi, luid);
}

/**
 * @param {string} luid
 * @param {string} queryOrMetaText
 * @param {Record<string, string>|undefined} urlByLuid
 * @returns {string}
 */
function resolveDatasourceBrowseUrl(luid, queryOrMetaText, urlByLuid) {
  const key = String(luid || "").toLowerCase();
  let url = (urlByLuid && key ? urlByLuid[key] : "") || "";
  if (!url) url = tryExtractBrowseUrlFromToolText(queryOrMetaText);
  if (!url) url = datasourceBrowseUrlFromEnvTemplate(luid);
  if (url && urlByLuid && key) urlByLuid[key] = url;
  return url;
}

function truncateToolText(text) {
  const s = text == null ? "" : String(text);
  if (s.length <= MAX_TOOL_TEXT_CHARS) return s;
  return (
    s.slice(0, MAX_TOOL_TEXT_CHARS) +
    `\n\n_(truncated; original length ${s.length} characters; set TABLEAU_MCP_MAX_RESULT_CHARS to raise limit)_`
  );
}

function parseQueryJson(args) {
  const qj = args.query_json ?? args.queryJson ?? args.query;
  if (qj == null) return { ok: false, error: "query_json is required (JSON string or object in args)." };
  if (typeof qj === "string") {
    try {
      return { ok: true, query: JSON.parse(qj) };
    } catch (e) {
      return { ok: false, error: "query_json must be valid JSON.", detail: e.message };
    }
  }
  if (typeof qj === "object") {
    return { ok: true, query: qj };
  }
  return { ok: false, error: "query_json must be a string or object." };
}

/**
 * @param {string} name - Gemini function name
 * @param {Record<string, unknown>} args
 * @param {{
 *   tableauMcpBaseUrl?: string,
 *   uploadQueue?: Array<{ buffer: Buffer, filename: string, title?: string }>,
 *   datasourceUrlByLuid?: Record<string, string>,
 *   viewUrlById?: Record<string, string>,
 * }} [toolOpts]
 * @returns {Promise<Record<string, unknown>>}
 */
async function dispatchTableauTool(name, args, toolOpts = {}) {
  if (!resolveTableauMcpUrl(toolOpts.tableauMcpBaseUrl)) {
    return { ok: false, error: "TABLEAU_MCP_SERVER is not configured." };
  }

  const a = args && typeof args === "object" ? args : {};
  const mcpOpts = { tableauMcpBaseUrl: toolOpts.tableauMcpBaseUrl };

  try {
    if (name === "tableau_list_datasources") {
      let limit = Number(a.limit);
      const configured = getDatasourceListLimit();
      if (!Number.isFinite(limit) || limit < 1) limit = configured;
      limit = Math.max(1, Math.floor(limit));
      const { text } = await callTableauTool("list-datasources", { limit }, mcpOpts);
      if (text && toolOpts.datasourceUrlByLuid) {
        mergeDatasourceUrlsFromListText(text, toolOpts.datasourceUrlByLuid);
      }
      return { ok: true, content: truncateToolText(text || "(empty response)") };
    }

    if (name === "tableau_get_datasource_metadata") {
      const luid = String(a.datasource_luid || a.datasourceLuid || "").trim();
      if (!luid) return { ok: false, error: "datasource_luid is required." };
      const { text } = await callTableauTool("get-datasource-metadata", { datasourceLuid: luid }, mcpOpts);
      const raw = text || "";
      const source_url = resolveDatasourceBrowseUrl(luid, raw, toolOpts.datasourceUrlByLuid);
      return {
        ok: true,
        content: truncateToolText(raw || "(empty response)"),
        ...(source_url ? { source_url } : {}),
        datasource_luid: luid,
      };
    }

    if (name === "tableau_query_datasource") {
      const parsed = parseQueryJson(a);
      if (!parsed.ok) return parsed;
      const coerced = coerceTableauMcpQueryInput(parsed.query);
      const luid = String(
        a.datasource_luid || a.datasourceLuid || coerced.embeddedLuid || ""
      ).trim();
      if (!luid) {
        return {
          ok: false,
          error:
            "datasource_luid is required (or embed datasource.datasourceLuid inside query_json).",
        };
      }
      const query = normalizeVizqlQueryObject(coerced.query);
      const mcpArgs = { datasourceLuid: luid, query };
      const lim = Number(a.limit);
      if (Number.isFinite(lim) && lim > 0) mcpArgs.limit = Math.floor(lim);
      const { text } = await callTableauTool("query-datasource", mcpArgs, mcpOpts);
      const raw = text || "";
      const source_url = resolveDatasourceBrowseUrl(luid, raw, toolOpts.datasourceUrlByLuid);
      return {
        ok: true,
        content: truncateToolText(raw || "(empty response)"),
        ...(source_url ? { source_url } : {}),
        datasource_luid: luid,
      };
    }

    if (name === "tableau_list_views") {
      /** @type {Record<string, unknown>} */
      const mcpArgs = {};
      if (a.filter != null && String(a.filter).trim()) mcpArgs.filter = String(a.filter).trim();
      const pageSize = Number(a.page_size ?? a.pageSize);
      if (Number.isFinite(pageSize) && pageSize > 0) mcpArgs.pageSize = Math.floor(pageSize);
      let lim = Number(a.limit);
      if (!Number.isFinite(lim) || lim < 1) lim = 200;
      mcpArgs.limit = Math.max(1, Math.floor(lim));
      const { text } = await callTableauTool("list-views", mcpArgs, mcpOpts);
      if (text && toolOpts.viewUrlById) {
        mergeViewUrlsFromListText(text, toolOpts.viewUrlById);
      }
      return { ok: true, content: truncateToolText(text || "(empty response)") };
    }

    if (name === "tableau_get_view_image") {
      const vid = String(a.view_id || a.viewId || "").trim();
      if (!vid) return { ok: false, error: "view_id is required (UUID from tableau_list_views)." };
      /** @type {Record<string, unknown>} */
      const mcpArgs = { viewId: vid };
      let w = Number(a.width);
      let h = Number(a.height);
      if (!Number.isFinite(w) || w <= 0) w = 1400;
      if (!Number.isFinite(h) || h <= 0) h = 900;
      mcpArgs.width = Math.floor(w);
      mcpArgs.height = Math.floor(h);
      const fmt = String(a.format || "PNG")
        .trim()
        .toUpperCase();
      if (fmt === "SVG" || fmt === "PNG") mcpArgs.format = fmt;
      const { result, text } = await callTableauTool("get-view-image", mcpArgs, mcpOpts);
      const images = extractImageBuffersFromMcpToolResult(result);
      if (images.length === 0) {
        return {
          ok: false,
          error: "Tableau MCP did not return image content.",
          content: truncateToolText(text || "(empty MCP response)"),
        };
      }
      let totalBytes = 0;
      for (const im of images) totalBytes += im.buffer.length;
      const kb = Math.max(1, Math.round(totalBytes / 1024));
      const q = toolOpts.uploadQueue;
      if (Array.isArray(q)) {
        let idx = 0;
        for (const im of images) {
          idx += 1;
          const ext = extensionForMime(im.mimeType);
          const suffix = images.length > 1 ? `-${idx}` : "";
          q.push({
            buffer: im.buffer,
            filename: `tableau-view-${vid.slice(0, 8)}${suffix}.${ext}`,
            title: `Tableau view (${vid.slice(0, 8)}…)`,
          });
        }
      }
      const source_url = toolOpts.viewUrlById?.[vid.toLowerCase()];
      return {
        ok: true,
        content: `Rendered view snapshot (~${kb} KB). The image is posted in this Slack thread right after the assistant message.`,
        ...(source_url ? { source_url } : {}),
        view_id: vid,
      };
    }

    return { ok: false, error: `Unknown Tableau tool: ${name}` };
  } catch (err) {
    const msg = err?.message || String(err);
    return { ok: false, error: msg, code: err?.code };
  }
}

function tableauQueryToolsEnabled(toolOpts = {}) {
  if (process.env.TABLEAU_MCP_QUERY_TOOLS === "0") return false;
  return !!resolveTableauMcpUrl(toolOpts.tableauMcpBaseUrl);
}

module.exports = {
  TABLEAU_FUNCTION_DECLARATIONS,
  isTableauGeminiTool,
  dispatchTableauTool,
  tableauQueryToolsEnabled,
};
