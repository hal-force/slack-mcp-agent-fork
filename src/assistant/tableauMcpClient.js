/**
 * Streamable HTTP client for Tableau MCP (Model Context Protocol).
 *
 * Base URL from TABLEAU_MCP_SERVER (e.g. https://host/tableau-mcp).
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
 * Effective base URL for MCP HTTP calls: user override when set, otherwise env default.
 * @param {string} [override] - optional per-user base URL
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
 * @param {string} toolName - MCP tool name, e.g. query-datasource
 * @param {Record<string, unknown>} toolArgs - arguments object for the tool
 * @returns {Promise<{ result: unknown, text: string }>}
 */
/**
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

function looksTableauRelated(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase();
  return (
    /\btableau\b/.test(t) ||
    /\bvizql\b/.test(t) ||
    /\bdatasource\b/.test(t) ||
    /\bdata source\b/.test(t) ||
    /\bworkbook\b/.test(t) ||
    (/\bview\b/.test(t) &&
      /\b(published|dashboard|sheet|screenshot|snapshot|thumbnail|image)\b/.test(t)) ||
    /\bhyper\b/.test(t) ||
    /\bextract\b/.test(t) ||
    /\bpulse\b/.test(t) ||
    /\b(hr|personnel|headcount|employees)\b/.test(t) ||
    /\b(summarize|summary|overview)\b.*\b(supply|program|project)\b/i.test(t) ||
    /\b(supply|program)\b.*\b(data|datasource)\b/i.test(t) ||
    /\b(cyber|supply chain|scrm|executive brief|key industries|north america)\b/.test(t)
  );
}

/** Recent thread mentioned analytics / listing (follow-ups after "list data sources"). */
function threadSuggestsTableauContext(text) {
  if (!text || typeof text !== "string") return false;
  if (
    /tableau|data\s*source|datasource|published|vizql|pulse|workbook|superstore|list.*source/i.test(text)
  ) {
    return true;
  }
  // Prior assistant message often includes a datasource LUID in backticks or plain text
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) {
    return true;
  }
  return false;
}

/** VizQL query example from Tableau MCP docs (query object only). */
const TABLEAU_QUERY_VIZQL_EXAMPLE = `{
  "fields": [
    { "fieldCaption": "Customer Name" },
    { "fieldCaption": "Sales", "function": "SUM", "fieldAlias": "Total Revenue", "sortDirection": "DESC", "sortPriority": 1 }
  ],
  "filters": [
    {
      "field": { "fieldCaption": "Customer Name" },
      "filterType": "TOP",
      "howMany": 5,
      "direction": "TOP",
      "fieldToMeasure": { "fieldCaption": "Sales", "function": "SUM" }
    }
  ]
}`;

function queryContractInTableauContextEnabled() {
  return process.env.TABLEAU_MCP_QUERY_TOOLS !== "0" && process.env.TABLEAU_MCP_QUERY_CONTRACT !== "0";
}

/**
 * Text block so Gemini sees the same query-datasource rules as Claude (schema from server + canonical example).
 * @param {unknown[]} tools - from MCP tools/list
 */
function formatQueryDatasourceContractHelp(tools) {
  const maxSchema = parseInt(process.env.TABLEAU_MCP_QUERY_SCHEMA_MAX_CHARS || "7000", 10);
  let block =
    "### `query-datasource` (Tableau MCP — same contract as Claude Desktop)\n" +
    "The MCP tool takes `datasourceLuid`, `query` (VizQL JSON), and optional `limit` (row cap).\n" +
    "In `query.fields`, each column uses **fieldCaption** exactly as returned by get-datasource-metadata (including characters like `|` in captions). For measures, set **function** to `SUM`, `AVG`, `COUNT`, `MEDIAN`, `MAX`, or `MIN` as appropriate.\n" +
    "Avoid `{ \"name\": \"...\" }`; the server expects **fieldCaption**. Start with a few fields, then add `filters` using `field: { \"fieldCaption\": \"...\" }` and a valid `filterType` per VizQL Data Service.\n\n" +
    "Official example `query` object:\n```json\n" +
    TABLEAU_QUERY_VIZQL_EXAMPLE +
    "\n```\n";

  const t = Array.isArray(tools) ? tools.find((x) => x && x.name === "query-datasource") : null;
  if (t && Number.isFinite(maxSchema) && maxSchema > 0) {
    if (t.description && String(t.description).trim()) {
      const d = String(t.description).trim();
      block +=
        "\n**Server tool description:**\n" + d.slice(0, 2500) + (d.length > 2500 ? "…\n" : "\n");
    }
    if (t.inputSchema) {
      let s = JSON.stringify(t.inputSchema, null, 2);
      if (s.length > maxSchema) s = s.slice(0, maxSchema) + "\n…(truncated)\n";
      block += "\n**Server inputSchema** (tools/list):\n```json\n" + s + "\n```\n";
    }
  }
  return block;
}

function summarizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  if (process.env.TABLEAU_MCP_VERBOSE_TOOLS === "1") {
    const maxTools = 24;
    const descMax = 180;
    const lines = tools.slice(0, maxTools).map((t) => {
      const name = t.name || "";
      let desc = (t.description || "").replace(/\s+/g, " ").trim();
      if (desc.length > descMax) desc = desc.slice(0, descMax) + "…";
      return desc ? `- *${name}*: ${desc}` : `- *${name}*`;
    });
    let out = lines.join("\n");
    if (tools.length > maxTools) out += `\n- _(${tools.length - maxTools} more tools omitted)_`;
    return out;
  }
  const names = tools.map((t) => t.name).filter(Boolean);
  return names.length ? names.join(", ") : "";
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
 * Tableau MCP `get-view-image` returns tools/call content with image parts shaped like:
 * `{ type: "image", data: "<base64>", mimeType: "image/png" }` (or `image/svg+xml` on supported servers).
 * @param {unknown} result - MCP tools/call result
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
    } catch (_) {
      // skip invalid base64
    }
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

/** Strip "Published data sources …" header so JSON.parse works on list-datasources tool text. */
function stripDatasourceListProsePrefix(raw) {
  let t = String(raw || "").trim();
  const lines = t.split("\n");
  if (lines[0] && /published data sources/i.test(lines[0])) {
    return lines.slice(1).join("\n").trim();
  }
  return t;
}

/**
 * Merge datasource LUID → browse URL from list-datasources JSON into an existing map (mutates).
 * @param {string} listText
 * @param {Record<string, string>} intoMap - keys are lowercased LUIDs
 */
function mergeDatasourceUrlsFromListText(listText, intoMap) {
  if (!intoMap || typeof intoMap !== "object") return;
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

/**
 * Parse list-views tool JSON (array or wrapped) for id + optional Tableau browse URL.
 * @param {string} listText
 * @returns {{ id: string, name: string, sourceUrl: string }[]}
 */
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

/**
 * @param {string} listText
 * @param {Record<string, string>} intoMap - keys are lowercased view ids
 */
function mergeViewUrlsFromListText(listText, intoMap) {
  if (!intoMap || typeof intoMap !== "object") return;
  for (const v of parseViewListEntries(listText)) {
    if (v.id && v.sourceUrl) intoMap[String(v.id).toLowerCase()] = v.sourceUrl;
  }
}

function extensionForMime(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("svg")) return "svg";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "png";
}

/**
 * Pull (luid, name) pairs from list-datasources tool text (JSON or line-oriented).
 */
function parseDatasourceCatalog(listText) {
  if (!listText || typeof listText !== "string") return [];
  const trimmed = stripDatasourceListProsePrefix(listText);
  const out = [];

  const pushPair = (luid, name, project = "", hintObj = null) => {
    if (!luid || !name) return;
    const matchHints = new Set();
    const sourceUrl = hintObj && typeof hintObj === "object" ? pickFirstHttpUrl(hintObj) : "";
    if (hintObj && typeof hintObj === "object") {
      const urls = [hintObj.contentUrl, hintObj.webpageUrl, hintObj.uri, hintObj.url].filter(Boolean);
      for (const u of urls) {
        for (const seg of lastMeaningfulPathSegments(String(u))) matchHints.add(seg);
      }
    }
    out.push({
      luid: String(luid),
      name: String(name).trim(),
      project: project ? String(project).trim() : "",
      matchHints: [...matchHints],
      sourceUrl,
    });
  };

  try {
    const j = JSON.parse(trimmed);
    const candidates = j.datasources || j.dataSources || j.data?.datasources || j.items;
    const arr = Array.isArray(candidates)
      ? candidates
      : candidates && typeof candidates === "object"
        ? Object.values(candidates)
        : Array.isArray(j)
          ? j
          : null;
    if (Array.isArray(arr)) {
      for (const d of arr) {
        if (!d || typeof d !== "object") continue;
        const luid = d.luid || d.id || d.datasourceLuid || d.contentLuid;
        const name = d.name || d.contentUrl || d.webpageUrl;
        const project = d.projectName || d.project?.name || "";
        if (luid && name) pushPair(luid, name, project, d);
      }
    }
  } catch (_) {
    // fall through to heuristics
  }

  if (out.length > 0) return out;

  const lineUuid = /^(.+?)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;
  for (const line of trimmed.split(/\n+/)) {
    const m = line.trim().match(lineUuid);
    if (m) pushPair(m[2], m[1].replace(/^[-*•\d.]+\s*/, "").trim(), "", null);
  }

  const inline = /"luid"\s*:\s*"([0-9a-f-]{36})"[^}]*"name"\s*:\s*"([^"]+)"/gi;
  let im;
  const s = trimmed;
  while ((im = inline.exec(s)) !== null) {
    pushPair(im[1], im[2], "", null);
  }

  return out;
}

/** UUIDs that appear in user/assistant text (e.g. LUID echoed in backticks). */
function extractDatasourceUuids(text) {
  if (!text || typeof text !== "string") return [];
  const re = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
  const seen = new Set();
  const ordered = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(m[1]);
    }
  }
  return ordered;
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Lowercase letters+digits only (for matching interos_scrm ↔ "Interos SCRM"). */
function compactAlphaNum(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function lastMeaningfulPathSegments(url, maxSeg = 8) {
  if (!url || typeof url !== "string") return [];
  try {
    const noQuery = url.split(/[?#]/)[0];
    const parts = noQuery.split("/").map((p) => p.trim()).filter(Boolean);
    const meaningful = [];
    for (const p of parts) {
      const base = p.replace(/\.(twb|tds|hyper|tde|twbx)$/i, "");
      if (base.length < 3) continue;
      if (/^[0-9a-f-]{36}$/i.test(base)) continue;
      meaningful.push(decodeURIComponent(base));
    }
    return meaningful.slice(-maxSeg);
  } catch (_) {
    return [];
  }
}

/**
 * Slugs and phrases the user might use as a data source id (underscores, URLs, "datasource X").
 */
function extractDatasourceCandidates(lexical) {
  if (!lexical || typeof lexical !== "string") return [];
  const seen = new Set();
  const add = (raw) => {
    const t = String(raw || "").trim();
    if (t.length < 2) return;
    seen.add(t);
    const nk = normalizeKey(t);
    if (nk.length >= 2) seen.add(nk);
    const comp = compactAlphaNum(t);
    if (comp.length >= 4) seen.add(comp);
  };

  const text = lexical;

  for (const m of text.matchAll(/`([^`\n]{2,120})`/g)) add(m[1]);
  for (const m of text.matchAll(/["']([a-z0-9_.\- ]{2,80})["']/gi)) add(m[1]);

  for (const m of text.matchAll(
    /\b(?:data\s*sources?|datasource|published\s+source)s?\s+(?:named|called)?\s*['"]?([a-z0-9][a-z0-9_.-]{1,70})\b/gi
  )) {
    add(m[1]);
  }

  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi)) add(m[0]);
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gi)) add(m[0]);

  const take = (s) => {
    const t = String(s || "").trim();
    if (t.length >= 4 && t.length <= 64 && /^[a-z0-9_.-]+$/i.test(t)) add(t);
  };
  take(
    (text.match(/\b(?:take|use)\s+(?:the\s+)?([a-z0-9][a-z0-9_.-]{2,60})\s+data\s+sources?\b/i) || [])[1]
  );

  return [...seen].filter(Boolean);
}

/**
 * Best catalog row matching user text (substring / token overlap).
 */
const STOPWORDS = new Set([
  "in",
  "on",
  "at",
  "by",
  "to",
  "of",
  "or",
  "the",
  "a",
  "an",
  "is",
  "it",
  "we",
  "you",
  "and",
  "for",
  "as",
  "be",
  "me",
  "my",
  "can",
  "get",
  "give",
  "out",
  "set",
  "use",
  "take",
]);

function rowMatchStrings(row) {
  const parts = [row.name, row.project];
  if (Array.isArray(row.matchHints)) parts.push(...row.matchHints);
  return parts.filter((p) => p && String(p).trim());
}

/**
 * @param {object} row - catalog row with optional matchHints
 * @param {string} lexical
 * @returns {number}
 */
function scoreDatasourceRow(row, lexical) {
  if (!lexical || !row) return 0;
  const msg = normalizeKey(lexical);
  if (!msg) return 0;
  const msgTokens = new Set(
    msg.split(/\s+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w))
  );
  const candidates = extractDatasourceCandidates(lexical);

  let best = 0;
  for (const str of rowMatchStrings(row)) {
    const n = normalizeKey(str);
    const c = compactAlphaNum(str);
    if (!n && !c) continue;
    let score = 0;

    if (n && (msg.includes(n) || n.includes(msg))) {
      score = Math.max(score, Math.min(n.length, 56));
    }
    for (const w of n.split(/\s+/)) {
      if (w.length >= 2 && !STOPWORDS.has(w) && msgTokens.has(w)) score += w.length + 1;
    }

    for (const cand of candidates) {
      const cc = compactAlphaNum(cand);
      if (!cc || cc.length < 3) continue;
      if (c && cc === c) score += 220;
      else if (c && c.length >= cc.length && c.includes(cc)) {
        score += 95 + Math.min(cc.length, 36);
      } else if (c && cc.length >= c.length && cc.includes(c)) {
        score += 88 + Math.min(c.length, 36);
      } else if (c && (c.startsWith(cc) || c.endsWith(cc)) && cc.length >= 5) {
        score += 52;
      }
    }

    const proj = normalizeKey(row.project || "");
    if (proj && msg.includes(proj)) score += 14;
    if (score > best) best = score;
  }
  return best;
}

/**
 * @param {string} lexical
 * @param {object[]} catalog
 * @returns {{ row: object, score: number }[]}
 */
function rankDatasourcesForMessage(lexical, catalog) {
  if (!lexical || !Array.isArray(catalog) || catalog.length === 0) return [];
  return catalog
    .map((row) => ({ row, score: scoreDatasourceRow(row, lexical) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

function pickDatasourceForMessage(lexical, catalog) {
  if (!lexical || !catalog.length) return null;
  const msg = normalizeKey(lexical);
  if (!msg) return null;

  const uuidRe = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
  let um;
  while ((um = uuidRe.exec(lexical)) !== null) {
    const id = um[1].toLowerCase();
    const row = catalog.find((r) => String(r.luid).toLowerCase() === id);
    if (row) return row;
  }

  const ranked = rankDatasourcesForMessage(lexical, catalog);
  if (ranked.length === 0) return null;

  const top = ranked[0];
  const second = ranked[1];
  const analytical =
    /\b(summarize|summary|overview|breakdown|by\s+department|metadata|fields?|describe|tell me about)\b/i.test(
      lexical
    );

  if (top.score >= 200) return top.row;
  if (top.score >= 95 && (!second || top.score >= second.score * 1.25)) return top.row;
  if (top.score >= 8 && (!second || top.score - second.score >= 6)) return top.row;
  if (top.score >= 3 && (!second || top.score - second.score >= 4)) return top.row;

  if (analytical && catalog.length === 1) return catalog[0];

  return null;
}

/**
 * When auto-pick is uncertain, short list for the model / user.
 * @param {string} lexical
 * @param {object[]} catalog
 * @param {number} [maxLines]
 */
function formatDatasourceMatchHints(lexical, catalog, maxLines = 5) {
  const ranked = rankDatasourcesForMessage(lexical, catalog);
  if (ranked.length === 0) return "";
  const lines = ranked.slice(0, maxLines).map(({ row, score }) => {
    const proj = row.project ? ` — _${row.project}_` : "";
    return `• *${row.name}* (\`${row.luid}\`)${proj} — match score ${score}`;
  });
  return (
    `*Closest published data sources* for this message (if the user’s name didn’t match exactly, pick the best row or ask them to confirm):\n` +
    lines.join("\n")
  );
}

const DEFAULT_DATASOURCE_LIST_LIMIT = 50;
const MIN_DATASOURCE_LIST_LIMIT = 1;

/**
 * Limit for list-datasources. Default 50 when env is unset.
 * If `TABLEAU_MCP_DATASOURCE_LIST_LIMIT` is set, that value is used (no upper clamp).
 */
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

async function tryListDatasources(baseUrl, sessionId) {
  try {
    const result = await mcpRequest(baseUrl, sessionId, "tools/call", {
      name: "list-datasources",
      arguments: { limit: getDatasourceListLimit() },
    });
    const text = textFromToolResult(result);
    return text ? `Published data sources (sample):\n${text}` : "";
  } catch (_) {
    return "";
  }
}

async function tryDatasourceMetadata(baseUrl, sessionId, datasourceLuid) {
  try {
    const result = await mcpRequest(baseUrl, sessionId, "tools/call", {
      name: "get-datasource-metadata",
      arguments: { datasourceLuid },
    });
    return textFromToolResult(result);
  } catch (_) {
    return "";
  }
}

function datasourceUrlMapFromCatalog(catalog) {
  /** @type {Record<string, string>} */
  const m = {};
  if (!Array.isArray(catalog)) return m;
  for (const row of catalog) {
    if (row?.luid && row.sourceUrl) m[String(row.luid).toLowerCase()] = row.sourceUrl;
  }
  return m;
}

/**
 * Build Tableau MCP context: compact tool list, datasource catalog, optional field metadata.
 * @param {string} userMessage
 * @param {{ threadHint?: string, tableauMcpBaseUrl?: string }} [opts] - recent thread text; optional per-user MCP base URL
 * @returns {Promise<{ context: string, datasourceUrls: Record<string, string> }>}
 */
async function buildTableauContext(userMessage = "", opts = {}) {
  const baseUrl = resolveTableauMcpUrl(opts.tableauMcpBaseUrl);
  if (!baseUrl) return { context: "", datasourceUrls: {} };

  const threadHint = (opts.threadHint || "").slice(-4000);
  const lexical = `${userMessage}\n${threadHint}`;

  try {
    const sessionId = await ensureSession(baseUrl);
    const toolsResult = await mcpRequest(baseUrl, sessionId, "tools/list", {});
    const tools = toolsResult?.tools ?? [];
    const toolSummary = summarizeTools(tools);

    const parts = [
      `Tableau MCP: ${baseUrl}`,
      "Ground answers in the sections below. Do not invent field captions, LUIDs, or numbers that are not shown. If the user names a data source that appears in the catalog, use the metadata section for exact fields.",
    ];

    if (toolSummary) {
      parts.push(
        process.env.TABLEAU_MCP_VERBOSE_TOOLS === "1"
          ? `Available Tableau tools:\n${toolSummary}`
          : `MCP server tools (this agent can call list/metadata/query/list-views/view-image via Gemini when TABLEAU_MCP_QUERY_TOOLS is not 0): ${toolSummary}`
      );
    }

    const wantDs =
      process.env.TABLEAU_MCP_LIST_DATASOURCES === "1" ||
      looksTableauRelated(lexical) ||
      threadSuggestsTableauContext(threadHint);

    let dsBlock = "";
    if (wantDs) {
      dsBlock = await tryListDatasources(baseUrl, sessionId);
      if (dsBlock) parts.push(dsBlock);
    }

    const catalog = dsBlock ? parseDatasourceCatalog(dsBlock) : [];
    let metaTarget = pickDatasourceForMessage(lexical, catalog);
    if (!metaTarget) {
      for (const id of extractDatasourceUuids(lexical)) {
        const row = catalog.find((r) => String(r.luid).toLowerCase() === id.toLowerCase());
        if (row) {
          metaTarget = row;
          break;
        }
      }
    }
    if (!metaTarget) {
      const ids = extractDatasourceUuids(lexical);
      if (ids.length === 1) {
        metaTarget = { luid: ids[0], name: "data source cited in this thread" };
      }
    }
    if (metaTarget) {
      const meta = await tryDatasourceMetadata(baseUrl, sessionId, metaTarget.luid);
      if (meta) {
        parts.push(
          `Datasource field metadata for *${metaTarget.name}* (luid \`${metaTarget.luid}\`) — use these field captions/parameters for breakdowns and filters:\n${meta}`
        );
      }
    } else if (
      catalog.length > 0 &&
      (looksTableauRelated(lexical) || threadSuggestsTableauContext(threadHint))
    ) {
      const hintBlock = formatDatasourceMatchHints(lexical, catalog);
      if (hintBlock) parts.push(hintBlock);
    }

    const wantQueryHelp =
      queryContractInTableauContextEnabled() &&
      (wantDs || looksTableauRelated(lexical) || threadSuggestsTableauContext(threadHint));
    if (wantQueryHelp) {
      const qh = formatQueryDatasourceContractHelp(tools);
      if (qh) parts.push(qh);
    }

    const body = parts.filter(Boolean).join("\n\n");
    if (!body) return { context: "", datasourceUrls: {} };

    const datasourceUrls = datasourceUrlMapFromCatalog(catalog);
    return {
      context:
        `\n--- Tableau context (from MCP endpoint) ---\n` +
        `${body}\n` +
        `--- End Tableau context ---\n`,
      datasourceUrls,
    };
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Tableau MCP context error:", err.message || err);
    }
    clearSession(baseUrl);
    return { context: "", datasourceUrls: {} };
  }
}

module.exports = {
  buildTableauContext,
  getTableauMcpUrl,
  getDefaultTableauMcpUrl,
  resolveTableauMcpUrl,
  validateTableauMcpUserUrl,
  clearSession,
  callTableauTool,
  getDatasourceListLimit,
  extractImageBuffersFromMcpToolResult,
  mergeDatasourceUrlsFromListText,
  mergeViewUrlsFromListText,
  extensionForMime,
};
