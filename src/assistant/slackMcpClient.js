/**
 * Slack MCP server — Streamable HTTP (initialize, Mcp-Session-Id, SSE or JSON bodies).
 *
 * @see https://docs.slack.dev/ai/mcp-server
 */

const { parseMcpResponse, streamableMcpPost } = require("./mcpHttpTransport");

const SLACK_MCP_URL = "https://mcp.slack.com/mcp";
const SESSION_TTL_MS = 25 * 60 * 1000;

/** @type {Map<string, { id: string, createdAt: number }>} */
const sessions = new Map();

let slackMcpNotEnabledWarned = false;

/**
 * Slack returns HTTP 400 when the app has not turned on MCP under Agents & AI Apps.
 * Log once with the dashboard link from the error body so it is obvious in dev.
 */
function warnIfSlackMcpNotEnabled(raw) {
  if (!raw || slackMcpNotEnabledWarned) return;
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (!/not enabled for Slack MCP|app-assistant/i.test(s)) return;
  slackMcpNotEnabledWarned = true;
  const m = s.match(/https:\/\/api\.slack\.com\/apps\/[^"\\\s]+\/app-assistant/);
  console.warn(
    "[slack-mcp-agent] Slack MCP is disabled for this app. Enable *Model Context Protocol* under " +
      "Slack app settings → Agents & AI Apps (Assistant)." +
      (m ? ` Open: ${m[0]}` : " Use your app’s Assistant / Agents settings page on api.slack.com.")
  );
}

function slackMcpDebug() {
  return process.env.SLACK_CONTEXT_DEBUG === "1" || process.env.SLACK_MCP_DEBUG === "1";
}

function clearSession(userToken) {
  sessions.delete(userToken);
}

function getSession(userToken) {
  const e = sessions.get(userToken);
  if (!e) return null;
  if (Date.now() - e.createdAt > SESSION_TTL_MS) {
    sessions.delete(userToken);
    return null;
  }
  return e;
}

async function ensureSession(userToken) {
  const existing = getSession(userToken);
  if (existing) return existing.id;

  const initId = 1;
  const { ok, status, text, headers } = await streamableMcpPost(
    SLACK_MCP_URL,
    { Authorization: `Bearer ${userToken}` },
    {
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "slack-mcp-agent", version: "1.0.0" },
      },
    }
  );

  if (!ok) {
    warnIfSlackMcpNotEnabled(text);
    const err = new Error(`Slack MCP HTTP ${status}: ${text.slice(0, 280)}`);
    err.status = status;
    throw err;
  }

  const sid = headers.get("mcp-session-id") || headers.get("Mcp-Session-Id");
  if (!sid) {
    throw new Error("Slack MCP initialize: missing Mcp-Session-Id header");
  }

  const initMsg = parseMcpResponse(text, initId);
  if (!initMsg || initMsg.error) {
    if (initMsg?.error) warnIfSlackMcpNotEnabled(initMsg.error.message || JSON.stringify(initMsg.error));
    throw new Error(initMsg?.error?.message || "Slack MCP initialize failed");
  }

  await streamableMcpPost(
    SLACK_MCP_URL,
    {
      Authorization: `Bearer ${userToken}`,
      "Mcp-Session-Id": sid,
    },
    { jsonrpc: "2.0", method: "notifications/initialized" }
  );

  sessions.set(userToken, { id: sid, createdAt: Date.now() });
  return sid;
}

/**
 * JSON-RPC to Slack MCP with session recovery on 401/404/invalid session.
 */
async function mcpRequest(userToken, method, params = {}) {
  const run = async () => {
    const rpcId = Math.floor(Math.random() * 1e9);
    const sessionId = await ensureSession(userToken);
    const { ok, status, text } = await streamableMcpPost(
      SLACK_MCP_URL,
      {
        Authorization: `Bearer ${userToken}`,
        "Mcp-Session-Id": sessionId,
      },
      {
        jsonrpc: "2.0",
        id: rpcId,
        method,
        params: params && typeof params === "object" ? params : {},
      }
    );

    if (!ok) {
      warnIfSlackMcpNotEnabled(text);
      const err = new Error(`Slack MCP HTTP ${status}: ${text.slice(0, 280)}`);
      err.status = status;
      throw err;
    }

    const msg = parseMcpResponse(text, rpcId);
    if (!msg) {
      const err = new Error(`Slack MCP: no JSON-RPC result for ${method}`);
      err.status = status;
      throw err;
    }
    if (msg.error) {
      const err = new Error(msg.error.message || JSON.stringify(msg.error));
      err.code = msg.error.code;
      throw err;
    }
    return msg.result;
  };

  try {
    return await run();
  } catch (e) {
    const st = e.status;
    const retry =
      st === 401 ||
      st === 404 ||
      /session|invalid session|unauthorized|401|404/i.test(e.message || "");
    if (retry) {
      clearSession(userToken);
      return await run();
    }
    throw e;
  }
}

async function listTools(userToken) {
  const result = await mcpRequest(userToken, "tools/list", {});
  return result?.tools ?? [];
}

async function callTool(userToken, name, args = {}) {
  const result = await mcpRequest(userToken, "tools/call", {
    name,
    arguments: typeof args === "object" && args !== null ? args : {},
  });
  return result?.content ?? [];
}

async function tryCallTool(userToken, toolName, attempts) {
  for (const args of attempts) {
    try {
      const content = await callTool(userToken, toolName, args);
      const text = content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
      if (text) return text;
    } catch (_) {}
  }
  return "";
}

/**
 * Build Slack context via MCP (channel/thread/search).
 */
async function buildContextViaMcp(userToken, opts = {}) {
  const { channelId, threadTs, userMessage = "" } = opts;
  const sections = [];

  try {
    const tools = await listTools(userToken);
    const toolList = Array.isArray(tools) ? tools : [];
    const byName = Object.fromEntries(toolList.map((t) => [t.name, t]));

    const readChannelName =
      toolList.find((t) => /read.*channel|channel.*history|conversations_history/i.test(t.name))?.name ||
      "read_channel";
    const readThreadName =
      toolList.find((t) => /read.*thread|thread.*replies|conversations_replies/i.test(t.name))?.name ||
      "read_thread";
    const searchName =
      toolList.find((t) => /search.*message|search_messages/i.test(t.name))?.name ||
      "search_messages";

    if (channelId && (byName[readThreadName] || byName[readChannelName])) {
      const toolName = threadTs ? readThreadName : readChannelName;
      if (byName[toolName]) {
        const text = await tryCallTool(userToken, toolName, [
          threadTs ? { channel_id: channelId, thread_ts: threadTs } : { channel_id: channelId },
          threadTs ? { channelId, threadTs } : { channelId },
        ]);
        if (text) sections.push(`Channel/thread context:\n${text}`);
      }
    }

    const query = (userMessage || "").trim();
    if (query.length >= 2 && byName[searchName]) {
      const text = await tryCallTool(userToken, searchName, [
        { query, count: 5 },
        { q: query },
      ]);
      if (text) sections.push(`Search results:\n${text}`);
    }
  } catch (err) {
    warnIfSlackMcpNotEnabled(err.message || "");
    if (slackMcpDebug()) {
      console.error("[slackMcpClient]", err.message || err);
    }
    return "";
  }

  if (sections.length === 0) return "";
  return `\n--- Slack context (internal workspace via MCP—prioritize this over general knowledge) ---\n${sections.join("\n\n")}\n--- End Slack context ---\n`;
}

module.exports = { mcpRequest, listTools, callTool, buildContextViaMcp, clearSession };
