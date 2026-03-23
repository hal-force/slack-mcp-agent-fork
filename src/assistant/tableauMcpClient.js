/**
 * Streamable HTTP client for Tableau MCP (Model Context Protocol).
 *
 * Base URL from TABLEAU_MCP_SERVER (e.g. https://host/tableau-mcp).
 */

const { parseMcpResponse, streamableMcpPost } = require("./mcpHttpTransport");

const SESSION_TTL_MS = 25 * 60 * 1000;

let _session = { id: null, createdAt: 0 };

function getTableauMcpUrl() {
  return (process.env.TABLEAU_MCP_SERVER || "").trim().replace(/\/$/, "");
}

function sessionValid() {
  return _session.id && Date.now() - _session.createdAt < SESSION_TTL_MS;
}

function clearSession() {
  _session = { id: null, createdAt: 0 };
}

async function postMcp(sessionId, bodyObj) {
  const url = getTableauMcpUrl();
  if (!url) throw new Error("TABLEAU_MCP_SERVER is not set");
  const headers = {};
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return streamableMcpPost(url, headers, bodyObj);
}

async function ensureSession() {
  if (sessionValid()) return _session.id;

  const initId = 1;
  const { ok, status, text, headers } = await postMcp(null, {
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

  _session = { id: sid, createdAt: Date.now() };

  await postMcp(_session.id, { jsonrpc: "2.0", method: "notifications/initialized" });

  return _session.id;
}

async function mcpRequest(sessionId, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  const { ok, text, status } = await postMcp(sessionId, {
    jsonrpc: "2.0",
    id,
    method,
    params: params && typeof params === "object" ? params : {},
  });

  if (!ok && status === 401) {
    clearSession();
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

function looksTableauRelated(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase();
  return (
    /\btableau\b/.test(t) ||
    /\bvizql\b/.test(t) ||
    /\bdatasource\b/.test(t) ||
    /\bdata source\b/.test(t) ||
    /\bworkbook\b/.test(t) ||
    (/\bview\b/.test(t) && /\b(published|dashboard|sheet)\b/.test(t)) ||
    /\bhyper\b/.test(t) ||
    /\bextract\b/.test(t) ||
    /\bpulse\b/.test(t) ||
    /\b(hr|personnel|headcount|employees)\b/.test(t) ||
    /\b(summarize|summary|overview)\b.*\b(supply|program|project)\b/i.test(t) ||
    /\b(supply|program)\b.*\b(data|datasource)\b/i.test(t)
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
 * Pull (luid, name) pairs from list-datasources tool text (JSON or line-oriented).
 */
function parseDatasourceCatalog(listText) {
  if (!listText || typeof listText !== "string") return [];
  const trimmed = listText.trim();
  const out = [];

  const pushPair = (luid, name, project = "") => {
    if (!luid || !name) return;
    out.push({
      luid: String(luid),
      name: String(name).trim(),
      project: project ? String(project).trim() : "",
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
        if (luid && name) pushPair(luid, name, project);
      }
    }
  } catch (_) {
    // fall through to heuristics
  }

  if (out.length > 0) return out;

  const lineUuid = /^(.+?)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;
  for (const line of trimmed.split(/\n+/)) {
    const m = line.trim().match(lineUuid);
    if (m) pushPair(m[2], m[1].replace(/^[-*•\d.]+\s*/, "").trim(), "");
  }

  const inline = /"luid"\s*:\s*"([0-9a-f-]{36})"[^}]*"name"\s*:\s*"([^"]+)"/gi;
  let im;
  const s = trimmed;
  while ((im = inline.exec(s)) !== null) {
    pushPair(im[1], im[2], "");
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
]);

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

  const msgTokens = new Set(
    msg.split(/\s+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w))
  );

  let best = null;
  let bestScore = 0;
  for (const row of catalog) {
    const n = normalizeKey(row.name);
    if (!n) continue;
    let score = 0;
    if (msg.includes(n) || n.includes(msg)) score = Math.max(score, Math.min(n.length, 48));
    for (const w of n.split(/\s+/)) {
      if (w.length >= 2 && !STOPWORDS.has(w) && msgTokens.has(w)) score += w.length;
    }
    const proj = normalizeKey(row.project || "");
    if (proj && msg.includes(proj)) score += 14;
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (bestScore >= 3) return best;

  const analytical =
    /\b(summarize|summary|overview|breakdown|by\s+department|metadata|fields?|describe|tell me about)\b/i.test(
      lexical
    );
  if (analytical && catalog.length === 1) return catalog[0];

  return null;
}

async function tryListDatasources(sessionId) {
  try {
    const result = await mcpRequest(sessionId, "tools/call", {
      name: "list-datasources",
      arguments: { limit: 20 },
    });
    const text = textFromToolResult(result);
    return text ? `Published data sources (sample):\n${text}` : "";
  } catch (_) {
    return "";
  }
}

async function tryDatasourceMetadata(sessionId, datasourceLuid) {
  try {
    const result = await mcpRequest(sessionId, "tools/call", {
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
 * @param {string} userMessage
 * @param {{ threadHint?: string }} [opts] - recent thread text so follow-up questions keep Tableau context
 */
async function buildTableauContext(userMessage = "", opts = {}) {
  if (!getTableauMcpUrl()) return "";

  const threadHint = (opts.threadHint || "").slice(-4000);
  const lexical = `${userMessage}\n${threadHint}`;

  try {
    const sessionId = await ensureSession();
    const toolsResult = await mcpRequest(sessionId, "tools/list", {});
    const tools = toolsResult?.tools ?? [];
    const toolSummary = summarizeTools(tools);

    const parts = [
      `Tableau MCP: ${getTableauMcpUrl()}`,
      "Ground answers in the sections below. Do not invent field captions, LUIDs, or numbers that are not shown. If the user names a data source that appears in the catalog, use the metadata section for exact fields.",
    ];

    if (toolSummary) {
      parts.push(
        process.env.TABLEAU_MCP_VERBOSE_TOOLS === "1"
          ? `Available Tableau tools:\n${toolSummary}`
          : `Tools (call via Tableau MCP from a full MCP client): ${toolSummary}`
      );
    }

    const wantDs =
      process.env.TABLEAU_MCP_LIST_DATASOURCES === "1" ||
      looksTableauRelated(lexical) ||
      threadSuggestsTableauContext(threadHint);

    let dsBlock = "";
    if (wantDs) {
      dsBlock = await tryListDatasources(sessionId);
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
      const meta = await tryDatasourceMetadata(sessionId, metaTarget.luid);
      if (meta) {
        parts.push(
          `Datasource field metadata for *${metaTarget.name}* (luid \`${metaTarget.luid}\`) — use these field captions/parameters for breakdowns and filters:\n${meta}`
        );
      }
    }

    const body = parts.filter(Boolean).join("\n\n");
    if (!body) return "";

    return (
      `\n--- Tableau context (from MCP endpoint) ---\n` +
      `${body}\n` +
      `--- End Tableau context ---\n`
    );
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Tableau MCP context error:", err.message || err);
    }
    clearSession();
    return "";
  }
}

module.exports = {
  buildTableauContext,
  getTableauMcpUrl,
  clearSession,
};
