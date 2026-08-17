/**
 * Shared helpers for MCP "Streamable HTTP" (JSON-RPC + optional SSE bodies).
 */

function rpcIdsEqual(msgId, expectedId) {
  if (msgId === expectedId) return true;
  if (msgId == null || expectedId == null) return false;
  return String(msgId) === String(expectedId);
}

/**
 * Split an SSE body into raw events. Events are separated by a blank line
 * (\n\n or \r\n\r\n). A trailing event without a terminating blank line is
 * still returned (some servers omit the final separator).
 */
function splitSseEvents(sseText) {
  return String(sseText || "")
    .replace(/\r\n/g, "\n")
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
}

/**
 * Per the SSE spec, a single event may carry its payload across multiple
 * `data:` lines that must be concatenated with "\n" before parsing. Servers do
 * this for large JSON-RPC results, so parsing each line on its own silently
 * drops big tool responses. Join the data lines, then parse once.
 */
function dataPayloadFromEvent(eventBlock) {
  const lines = eventBlock.split("\n").map((l) => l.trim());
  const dataLines = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    // "data:" and "data: " are both valid; strip the single optional leading space.
    dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  return dataLines.length ? dataLines.join("\n") : null;
}

/**
 * Parse SSE body and return the JSON-RPC message whose id matches expectedId.
 * When several matching messages appear, the last one wins (final result after
 * any interim progress notifications sharing the id).
 */
function parseSseForId(sseText, expectedId) {
  let found = null;
  for (const block of splitSseEvents(sseText)) {
    const payload = dataPayloadFromEvent(block);
    if (!payload || payload === "[DONE]") continue;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch (_) {
      continue;
    }
    if (rpcIdsEqual(msg.id, expectedId)) found = msg;
  }
  return found;
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

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_MAX_ATTEMPTS = 3;

function mcpRetryConfig() {
  const attempts = parseInt(process.env.MCP_HTTP_MAX_ATTEMPTS || "", 10);
  const base = parseInt(process.env.MCP_HTTP_RETRY_BASE_MS || "", 10);
  return {
    maxAttempts: Number.isFinite(attempts) && attempts >= 1 ? attempts : DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: Number.isFinite(base) && base >= 0 ? base : 300,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry only on transient conditions: network/abort errors and 5xx (incl. 429). */
function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function streamableMcpPost(url, headers, bodyObj, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { maxAttempts, baseDelayMs } = mcpRetryConfig();
  const debug = process.env.SLACK_MCP_DEBUG === "1" || process.env.SLACK_CONTEXT_DEBUG === "1";
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(bodyObj),
        // SSRF: a validated public host must not 30x-redirect us to an internal
        // one. Fail closed rather than follow the redirect to an unchecked host.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();

      if (!res.ok && isRetriableStatus(res.status) && attempt < maxAttempts) {
        if (debug) console.warn(`[mcpHttpTransport] HTTP ${res.status} on attempt ${attempt}/${maxAttempts}; retrying`);
        await sleep(baseDelayMs * attempt);
        continue;
      }
      return { ok: res.ok, status: res.status, headers: res.headers, text };
    } catch (err) {
      // Network failure / timeout (AbortError). Retry unless out of attempts.
      lastErr = err;
      if (attempt < maxAttempts) {
        if (debug) console.warn(`[mcpHttpTransport] ${err.name || "error"} on attempt ${attempt}/${maxAttempts}; retrying`);
        await sleep(baseDelayMs * attempt);
        continue;
      }
    }
  }
  throw lastErr || new Error("streamableMcpPost failed");
}

module.exports = {
  parseSseForId,
  parseMcpResponse,
  streamableMcpPost,
  // exported for tests
  splitSseEvents,
  dataPayloadFromEvent,
  isRetriableStatus,
};
