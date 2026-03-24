/**
 * Gemini function declarations + dispatch for Tableau MCP (query, list, metadata).
 */

const { FunctionDeclarationSchemaType } = require("@google-cloud/vertexai");
const { callTableauTool, getTableauMcpUrl, getDatasourceListLimit } = require("./tableauMcpClient");
const { coerceTableauMcpQueryInput, normalizeVizqlQueryObject } = require("./vizqlNormalize");

const T = FunctionDeclarationSchemaType;

const TABLEAU_GEMINI_TOOL_NAMES = new Set([
  "tableau_query_datasource",
  "tableau_list_datasources",
  "tableau_get_datasource_metadata",
]);

function isTableauGeminiTool(name) {
  return TABLEAU_GEMINI_TOOL_NAMES.has(name);
}

const TABLEAU_FUNCTION_DECLARATIONS = [
  {
    name: "tableau_list_datasources",
    description:
      "List published Tableau data sources from the connected MCP server. Use when the user asks what sources exist or you need a datasource_luid not already in context.",
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
 * @returns {Promise<Record<string, unknown>>}
 */
async function dispatchTableauTool(name, args) {
  if (!getTableauMcpUrl()) {
    return { ok: false, error: "TABLEAU_MCP_SERVER is not configured." };
  }

  const a = args && typeof args === "object" ? args : {};

  try {
    if (name === "tableau_list_datasources") {
      let limit = Number(a.limit);
      const configured = getDatasourceListLimit();
      if (!Number.isFinite(limit) || limit < 1) limit = configured;
      limit = Math.max(1, Math.floor(limit));
      const { text } = await callTableauTool("list-datasources", { limit });
      return { ok: true, content: truncateToolText(text || "(empty response)") };
    }

    if (name === "tableau_get_datasource_metadata") {
      const luid = String(a.datasource_luid || a.datasourceLuid || "").trim();
      if (!luid) return { ok: false, error: "datasource_luid is required." };
      const { text } = await callTableauTool("get-datasource-metadata", { datasourceLuid: luid });
      return { ok: true, content: truncateToolText(text || "(empty response)") };
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
      const { text } = await callTableauTool("query-datasource", mcpArgs);
      return { ok: true, content: truncateToolText(text || "(empty response)") };
    }

    return { ok: false, error: `Unknown Tableau tool: ${name}` };
  } catch (err) {
    const msg = err?.message || String(err);
    return { ok: false, error: msg, code: err?.code };
  }
}

function tableauQueryToolsEnabled() {
  if (process.env.TABLEAU_MCP_QUERY_TOOLS === "0") return false;
  return !!getTableauMcpUrl();
}

module.exports = {
  TABLEAU_FUNCTION_DECLARATIONS,
  isTableauGeminiTool,
  dispatchTableauTool,
  tableauQueryToolsEnabled,
};
