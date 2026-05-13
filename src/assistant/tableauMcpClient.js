/**
 * Streamable HTTP client for Tableau MCP (Model Context Protocol).
 *
 * Handles: URL resolution, session management (init / TTL / 401 recovery),
 * raw MCP request execution, and result utility helpers.
 *
 * Context building (datasource catalog, scoring, prompt assembly) lives in
 * tableauContextBuilder.js.
 */

const { parseMcpResponse, streamableMcpPost } = require("./mcpHttpTransport");

const SESSION_TTL_MS = 25 * 60 * 1000;

/** @type {Map<string, { id: string, createdAt: number }>} */
const _sessionsByBaseUrl = new Map();

function normalizeTableauBaseUrl(raw) {
  return (raw || "").trim().replace(/\/$/, "");
}

/** Deployment default from env (no per-user override). */
function getDefaultTableauMcpUrl() {
  return normalizeTableauBaseUrl(process.env.TABLEAU_MCP_SERVER || "");
}

/**
 * Effective base URL: user override when set, otherwise env default.
 * @param {string} [override]
 */
function resolveTableauMcpUrl(override) {
  const o = normalizeTableauBaseUrl(override);
  if (o) return o;
  return getDefaultTableauMcpUrl();
}

/** @deprecated use getDefaultTableauMcpUrl */
function getTableauMcpUrl() {
  return getDefaultTableauMcpUrl();
}

/**
 * Validate a user-supplied MCP base URL (App Home settings).
 * @returns {{ ok: true, url: string | null } | { ok: false, error: string }}
 */
function validateTableauMcpUserUrl(raw) {
  const s = (raw || "").trim();
  if (!s) return { ok: true, url: null };
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") {
      return { ok: false, error: "URL must use https://" };
    }
    return { ok: true, url: normalizeTableauBaseUrl(s) };
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
}

function sessionValid(entry) {
  return entry?.id && Date.now() - entry.createdAt < SESSION_TTL_MS;
}

/** Clear cached MCP session for one base URL, or all URLs if omitted. */
function clearSession(baseUrl) {
  const key = normalizeTableauBaseUrl(baseUrl);
  if (key) _sessionsByBaseUrl.delete(key);
  else _sessionsByBaseUrl.clear();
}

async function postMcp(baseUrl, sessionId, bodyObj) {
  const url = normalizeTableauBaseUrl(baseUrl);
  if (!url) throw new Error("TABLEAU_MCP_SERVER is not set");
  const headers = {};
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return streamableMcpPost(url, headers, bodyObj);
}

async function ensureSession(baseUrl) {
  const key = normalizeTableauBaseUrl(baseUrl);
  if (!key) throw new Error("TABLEAU_MCP_SERVER is not set");

  const existing = _sessionsByBaseUrl.get(key);
  if (sessionValid(existing)) return existing.id;

  const initId = 1;
  const { ok, status, text, headers } = await postMcp(key, null, {
    jsonrpc: "2.0",
    id: initId,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "slack-mcp-agent", version: "1.0.0" },
    },
  });

  if (!ok) {
    throw new Error(`Tableau MCP initialize HTTP ${status}: ${text.slice(0, 200)}`);
  }

  const sid = headers.get("mcp-session-id") || headers.get("Mcp-Session-Id");
  if (!sid) {
    throw new Error("Tableau MCP initialize: missing Mcp-Session-Id header");
  }

  const initMsg = parseMcpResponse(text, initId);
  if (!initMsg || initMsg.error) {
    throw new Error(initMsg?.error?.message || "Tableau MCP initialize failed");
  }

  _sessionsByBaseUrl.set(key, { id: sid, createdAt: Date.now() });

  await postMcp(key, sid, { jsonrpc: "2.0", method: "notifications/initialized" });

  return sid;
}

async function mcpRequest(baseUrl, sessionId, method, params = {}) {
  const key = normalizeTableauBaseUrl(baseUrl);
  const id = Math.floor(Math.random() * 1e9);
  const { ok, text, status } = await postMcp(key, sessionId, {
    jsonrpc: "2.0",
    id,
    method,
    params: params && typeof params === "object" ? params : {},
  });

  if (!ok && status === 401) {
    clearSession(key);
  }

  const msg = parseMcpResponse(text, id);
  if (!msg) {
    throw new Error(`Tableau MCP: no JSON-RPC result for ${method} (HTTP ${status})`);
  }
  if (msg.error) {
    const err = new Error(msg.error.message || JSON.stringify(msg.error));
    err.code = msg.error.code;
    throw err;
  }
  return msg.result;
}

/**
 * Invoke a Tableau MCP tool (tools/call). Reuses the module session.
 * @param {string} toolName
 * @param {Record<string, unknown>} toolArgs
 * @param {{ tableauMcpBaseUrl?: string }} [opts]
 */
async function callTableauTool(toolName, toolArgs, opts = {}) {
  const baseUrl = resolveTableauMcpUrl(opts.tableauMcpBaseUrl);
  const sessionId = await ensureSession(baseUrl);
  const result = await mcpRequest(baseUrl, sessionId, "tools/call", {
    name: toolName,
    arguments: toolArgs && typeof toolArgs === "object" ? toolArgs : {},
  });
  return { result, text: textFromToolResult(result) };
}

function textFromToolResult(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
}

/**
 * Extract image buffers from a get-view-image tools/call result.
 * @param {unknown} result
 * @returns {{ buffer: Buffer, mimeType: string }[]}
 */
function extractImageBuffersFromMcpToolResult(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c || c.type !== "image") continue;
    const mimeType = typeof c.mimeType === "string" && c.mimeType.trim() ? c.mimeType.trim() : "image/png";
    const data = c.data;
    if (typeof data !== "string" || !data) continue;
    try {
      const buffer = Buffer.from(data, "base64");
      if (buffer.length) out.push({ buffer, mimeType });
    } catch (_) {}
  }
  return out;
}

function extensionForMime(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("svg")) return "svg";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "png";
}

/**
 * Merge datasource LUID → browse URL from list-datasources JSON into an existing map.
 * Delegates parsing to tableauContextBuilder to avoid circular deps.
 */
function mergeDatasourceUrlsFromListText(listText, intoMap) {
  if (!intoMap || typeof intoMap !== "object") return;
  const { parseDatasourceCatalog } = require("./tableauContextBuilder");
  const catalog = parseDatasourceCatalog(listText);
  for (const row of catalog) {
    if (row.sourceUrl && row.luid) intoMap[String(row.luid).toLowerCase()] = row.sourceUrl;
  }
}

function normalizeViewListArray(j) {
  const arr = Array.isArray(j) ? j : j?.views || j?.data?.views;
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) {
    if (!v || typeof v !== "object") continue;
    const id = v.id || v.viewId || v.luid;
    const name = v.name || v.viewName || "View";
    if (!id) continue;
    let sourceUrl = pickFirstHttpUrl(v);
    if (!sourceUrl && v.workbook && typeof v.workbook === "object") {
      sourceUrl = pickFirstHttpUrl(v.workbook);
    }
    out.push({ id: String(id), name: String(name), sourceUrl });
  }
  return out;
}

function pickFirstHttpUrl(obj) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of ["webpageUrl", "contentUrl", "url", "uri"]) {
    const v = obj[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return "";
}

function parseViewListEntries(listText) {
  let t = String(listText || "").trim();
  try {
    return normalizeViewListArray(JSON.parse(t));
  } catch (_) {
    const start = t.search(/[\[{]/);
    if (start > 0) {
      t = t.slice(start);
      try {
        return normalizeViewListArray(JSON.parse(t));
      } catch (_) {
        return [];
      }
    }
  }
  return [];
}

function mergeViewUrlsFromListText(listText, intoMap) {
  if (!intoMap || typeof intoMap !== "object") return;
  for (const v of parseViewListEntries(listText)) {
    if (v.id && v.sourceUrl) intoMap[String(v.id).toLowerCase()] = v.sourceUrl;
  }
}

const DEFAULT_DATASOURCE_LIST_LIMIT = 50;
const MIN_DATASOURCE_LIST_LIMIT = 1;

function getDatasourceListLimit() {
  const raw = process.env.TABLEAU_MCP_DATASOURCE_LIST_LIMIT;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_DATASOURCE_LIST_LIMIT;
  }
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < MIN_DATASOURCE_LIST_LIMIT) {
    return DEFAULT_DATASOURCE_LIST_LIMIT;
  }
  return Math.floor(n);
}

module.exports = {
  // Context builder (re-exported for backward compat with callers that import from here)
  buildTableauContext: (...args) => require("./tableauContextBuilder").buildTableauContext(...args),
  // URL / session
  getTableauMcpUrl,
  getDefaultTableauMcpUrl,
  resolveTableauMcpUrl,
  validateTableauMcpUserUrl,
  clearSession,
  ensureSession,
  mcpRequest,
  // Tool invocation
  callTableauTool,
  getDatasourceListLimit,
  // Result helpers
  textFromToolResult,
  extractImageBuffersFromMcpToolResult,
  mergeDatasourceUrlsFromListText,
  mergeViewUrlsFromListText,
  extensionForMime,
};
