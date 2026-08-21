/**
 * Tableau context builder — builds the AI context block from Tableau MCP.
 *
 * Split from tableauMcpClient.js so that HTTP session management stays in that file
 * and all application-logic decisions (when to fetch datasource list, how to match
 * datasources, how to format the prompt block) live here.
 */

const { mcpRequest, resolveTableauMcpUrl, ensureSession, clearSession, textFromToolResult } = require("./tableauMcpClient");
const { lexicalWantTableau } = require("../router/intentRouter");

// The MCP server's tool catalog (tools/list) is effectively static for a given
// server, but was re-fetched on every turn. Cache it per base URL with a TTL so
// most turns skip that round-trip (E6). clearSession-style invalidation isn't
// needed — a stale list at worst omits a just-added tool for a few minutes.
const TOOLS_LIST_TTL_MS = 15 * 60 * 1000;
/** @type {Map<string, { tools: unknown[], at: number }>} */
const _toolsListCache = new Map();

async function getToolsList(baseUrl, sessionId) {
  const hit = _toolsListCache.get(baseUrl);
  if (hit && Date.now() - hit.at < TOOLS_LIST_TTL_MS) return hit.tools;
  const toolsResult = await mcpRequest(baseUrl, sessionId, "tools/list", {});
  const tools = toolsResult?.tools ?? [];
  // Only cache a non-empty catalog; an empty result is likely a transient error.
  if (tools.length) _toolsListCache.set(baseUrl, { tools, at: Date.now() });
  return tools;
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
 * Text block so Gemini sees the same query-datasource rules as Claude.
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

function pickFirstHttpUrl(obj) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of ["webpageUrl", "contentUrl", "url", "uri"]) {
    const v = obj[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return "";
}

function stripDatasourceListProsePrefix(raw) {
  let t = String(raw || "").trim();
  const lines = t.split("\n");
  if (lines[0] && /published data sources/i.test(lines[0])) {
    return lines.slice(1).join("\n").trim();
  }
  return t;
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

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

const STOPWORDS = new Set([
  "in", "on", "at", "by", "to", "of", "or", "the", "a", "an", "is", "it",
  "we", "you", "and", "for", "as", "be", "me", "my", "can", "get", "give",
  "out", "set", "use", "take",
]);

function rowMatchStrings(row) {
  const parts = [row.name, row.project];
  if (Array.isArray(row.matchHints)) parts.push(...row.matchHints);
  return parts.filter((p) => p && String(p).trim());
}

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

function formatDatasourceMatchHints(lexical, catalog, maxLines = 5) {
  const ranked = rankDatasourcesForMessage(lexical, catalog);
  if (ranked.length === 0) return "";
  const lines = ranked.slice(0, maxLines).map(({ row, score }) => {
    const proj = row.project ? ` — _${row.project}_` : "";
    return `• *${row.name}* (\`${row.luid}\`)${proj} — match score ${score}`;
  });
  return (
    `*Closest published data sources* for this message (if the user's name didn't match exactly, pick the best row or ask them to confirm):\n` +
    lines.join("\n")
  );
}

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

/**
 * Pull (luid, name) pairs from list-datasources tool text.
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
    // Tableau MCP v4's list-datasources returns { data: [ ...rows ], totalAvailable }.
    // Earlier shapes used j.datasources / j.dataSources / j.data.datasources / j.items.
    // Handle j.data being the row array directly (v4) as well as the older nested forms.
    const candidates =
      j.datasources ||
      j.dataSources ||
      (Array.isArray(j.data) ? j.data : j.data?.datasources) ||
      j.items;
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

/**
 * Render a parsed catalog as a compact one-line-per-row list for the model
 * context. The raw list-datasources JSON is ~30k tokens for a few hundred
 * datasources; this form (name — project — luid) is ~1/6 the size and carries
 * everything needed to identify and pick a datasource. The matched datasource's
 * full field metadata is added separately by the caller.
 *
 * @param {Array<{name:string, luid:string, project?:string}>} catalog
 * @param {number} [maxRows] - safety cap on rendered rows
 * @returns {string} compact block, or "" if the catalog is empty
 */
function formatDatasourceCatalogCompact(catalog, maxRows = 500) {
  if (!Array.isArray(catalog) || catalog.length === 0) return "";
  const rows = catalog.slice(0, maxRows).map((r) => {
    const proj = r.project ? ` — ${r.project}` : "";
    return `• ${r.name}${proj} — \`${r.luid}\``;
  });
  const header = `Published data sources (${catalog.length} total; name — project — luid):`;
  let out = `${header}\n${rows.join("\n")}`;
  if (catalog.length > maxRows) {
    out += `\n…(${catalog.length - maxRows} more not shown)`;
  }
  return out;
}

function datasourceUrlMapFromCatalog(catalog) {
  const m = {};
  if (!Array.isArray(catalog)) return m;
  for (const row of catalog) {
    if (row?.luid && row.sourceUrl) m[String(row.luid).toLowerCase()] = row.sourceUrl;
  }
  return m;
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

/**
 * Build Tableau MCP context: compact tool list, datasource catalog, optional field metadata.
 *
 * @param {string} userMessage
 * @param {{
 *   threadHint?: string,
 *   tableauMcpBaseUrl?: string,
 *   wantTableau?: boolean,
 *   liveToolsActive?: boolean,
 * }} [opts]
 * @returns {Promise<{ context: string, datasourceUrls: Record<string, string> }>}
 */
async function buildTableauContext(userMessage = "", opts = {}) {
  const baseUrl = resolveTableauMcpUrl(opts.tableauMcpBaseUrl);
  if (!baseUrl) return { context: "", datasourceUrls: {} };

  const threadHint = (opts.threadHint || "").slice(-4000);
  const lexical = `${userMessage}\n${threadHint}`;

  try {
    const sessionId = await ensureSession(baseUrl);
    const tools = await getToolsList(baseUrl, sessionId);
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

    // When the model will call Tableau tools live in-turn (Bedrock), it fetches
    // the datasource catalog/metadata itself with a proper name filter. Skip the
    // large unfiltered pre-fetch here — keep only the tool summary + query
    // contract below, which tell the model what to call (E3).
    if (opts.liveToolsActive) {
      const wantQueryHelp = queryContractInTableauContextEnabled();
      if (wantQueryHelp) {
        const qh = formatQueryDatasourceContractHelp(tools);
        if (qh) parts.push(qh);
      }
      const body = parts.filter(Boolean).join("\n\n");
      if (!body) return { context: "", datasourceUrls: {} };
      return {
        context:
          `\n--- Tableau context (from MCP endpoint) ---\n` +
          `${body}\n` +
          `--- End Tableau context ---\n`,
        datasourceUrls: {},
      };
    }

    // wantTableau from caller (intent router) takes precedence; fall back to lexical detection.
    const wantDs =
      process.env.TABLEAU_MCP_LIST_DATASOURCES === "1" ||
      opts.wantTableau === true ||
      (opts.wantTableau === undefined && lexicalWantTableau(lexical));

    let dsBlock = "";
    let catalog = [];
    if (wantDs) {
      dsBlock = await tryListDatasources(baseUrl, sessionId);
      catalog = dsBlock ? parseDatasourceCatalog(dsBlock) : [];
      // Prefer a compact catalog (name — project — luid) over the raw ~30k-token
      // JSON dump. Fall back to the raw block only if parsing yielded nothing,
      // so an unexpected server shape never silently drops the catalog.
      const compact = formatDatasourceCatalogCompact(catalog);
      if (compact) parts.push(compact);
      else if (dsBlock) parts.push(dsBlock);
    }
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
    } else if (catalog.length > 0 && wantDs) {
      const hintBlock = formatDatasourceMatchHints(lexical, catalog);
      if (hintBlock) parts.push(hintBlock);
    }

    const wantQueryHelp = queryContractInTableauContextEnabled() && wantDs;
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
    // Log unconditionally (only the error message, never secrets): in a live
    // demo (NODE_ENV=production) a swallowed Tableau failure was previously
    // invisible, making "the agent answered with no data" impossible to
    // diagnose. This warn is the one breadcrumb for that case.
    console.warn("[tableau-context] MCP context unavailable:", err.message || err);
    clearSession(baseUrl);
    return { context: "", datasourceUrls: {} };
  }
}

module.exports = {
  buildTableauContext,
  parseDatasourceCatalog,
  rankDatasourcesForMessage,
  scoreDatasourceRow,
  formatDatasourceMatchHints,
  formatDatasourceCatalogCompact,
};
