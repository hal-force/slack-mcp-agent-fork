/**
 * Minimal MCP client for the Slack MCP server (https://mcp.slack.com/mcp).
 * Sends JSON-RPC 2.0 requests over HTTP with Bearer token (user token).
 *
 * @see https://docs.slack.dev/ai/mcp-server
 */

const SLACK_MCP_URL = "https://mcp.slack.com/mcp";

/**
 * Send a single JSON-RPC request to the Slack MCP server.
 *
 * @param {string} userToken - Slack user token (xoxp-...); required for MCP
 * @param {string} method - JSON-RPC method (e.g. "tools/list", "tools/call")
 * @param {Object} [params] - Method params
 * @returns {Promise<Object>} JSON-RPC result (or throws on error/result.error)
 */
async function mcpRequest(userToken, method, params = {}) {
  const id = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: typeof params === "object" && params !== null ? params : {},
  });

  const res = await fetch(SLACK_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userToken}`,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Slack MCP HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message || JSON.stringify(data.error));
    err.code = data.error.code;
    throw err;
  }
  if (data.id !== id) {
    throw new Error("Slack MCP response id mismatch");
  }
  return data.result;
}

/**
 * List tools offered by the Slack MCP server.
 *
 * @param {string} userToken - Slack user token
 * @returns {Promise<Array<{name: string, description?: string, inputSchema?: object}>>}
 */
async function listTools(userToken) {
  const result = await mcpRequest(userToken, "tools/list", {});
  return result?.tools ?? [];
}

/**
 * Call a Slack MCP tool.
 *
 * @param {string} userToken - Slack user token
 * @param {string} name - Tool name (from tools/list)
 * @param {Object} [args] - Tool arguments
 * @returns {Promise<Array<{type: string, text?: string, ...}>} Tool result content (e.g. [{ type: "text", text: "..." }])
 */
async function callTool(userToken, name, args = {}) {
  const result = await mcpRequest(userToken, "tools/call", {
    name,
    arguments: typeof args === "object" && args !== null ? args : {},
  });
  return result?.content ?? [];
}

/** Try calling a tool with different argument shapes; return concatenated text content. */
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
 * Build Slack context by calling the Slack MCP server (read channel/thread, search).
 * Discovers tool names via tools/list, then calls the appropriate tools.
 *
 * @param {string} userToken - Slack user token (xoxp-...)
 * @param {Object} opts - channelId, threadTs, userMessage, etc.
 * @returns {Promise<string>} Formatted context string or empty on failure
 */
async function buildContextViaMcp(userToken, opts = {}) {
  const { channelId, threadTs, userMessage = "" } = opts;
  const sections = [];

  try {
    const tools = await listTools(userToken);
    const toolList = Array.isArray(tools) ? tools : [];
    const byName = Object.fromEntries(toolList.map((t) => [t.name, t]));

    // Possible Slack MCP tool names (discovered from tools/list if different)
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
    if (process.env.NODE_ENV !== "production") {
      console.error("Slack MCP buildContext error:", err.message);
    }
    return "";
  }

  if (sections.length === 0) return "";
  return `\n--- Slack context (from Slack MCP server) ---\n${sections.join("\n\n")}\n--- End Slack context ---\n`;
}

module.exports = { mcpRequest, listTools, callTool, buildContextViaMcp };
