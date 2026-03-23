/**
 * Shared helpers for MCP "Streamable HTTP" (JSON-RPC + optional SSE bodies).
 */

function rpcIdsEqual(msgId, expectedId) {
  if (msgId === expectedId) return true;
  if (msgId == null || expectedId == null) return false;
  return String(msgId) === String(expectedId);
}

/**
 * Parse SSE body: `data: {...}` lines; return JSON-RPC message whose id matches expectedId.
 */
function parseSseForId(sseText, expectedId) {
  const blocks = sseText.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const msg = JSON.parse(payload);
        if (rpcIdsEqual(msg.id, expectedId)) return msg;
      } catch (_) {
        // ignore
      }
    }
  }
  return null;
}

/**
 * Try whole body as single JSON-RPC object (some servers return application/json).
 */
function parseJsonRpcBody(text, expectedId) {
  const t = (text || "").trim();
  if (!t.startsWith("{")) return null;
  try {
    const msg = JSON.parse(t);
    if (msg && rpcIdsEqual(msg.id, expectedId)) return msg;
  } catch (_) {
    return null;
  }
  return null;
}

function parseMcpResponse(text, expectedId) {
  return parseJsonRpcBody(text, expectedId) || parseSseForId(text, expectedId);
}

async function streamableMcpPost(url, headers, bodyObj, timeoutMs = 45000) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, headers: res.headers, text };
}

module.exports = {
  parseSseForId,
  parseMcpResponse,
  streamableMcpPost,
};
