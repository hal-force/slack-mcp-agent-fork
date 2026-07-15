const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { streamableMcpPost } = require("../src/assistant/mcpHttpTransport");

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.MCP_HTTP_RETRY_BASE_MS;
  delete process.env.MCP_HTTP_MAX_ATTEMPTS;
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("retries on 503 then succeeds", async () => {
  process.env.MCP_HTTP_RETRY_BASE_MS = "0";
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls < 3) return jsonResponse(503, "busy");
    return jsonResponse(200, { ok: true });
  };
  const res = await streamableMcpPost("https://x", {}, { hi: 1 });
  assert.equal(calls, 3);
  assert.equal(res.status, 200);
});

test("does not retry on 400", async () => {
  process.env.MCP_HTTP_RETRY_BASE_MS = "0";
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return jsonResponse(400, "bad");
  };
  const res = await streamableMcpPost("https://x", {}, {});
  assert.equal(calls, 1);
  assert.equal(res.status, 400);
});

test("retries on network error then throws after max attempts", async () => {
  process.env.MCP_HTTP_RETRY_BASE_MS = "0";
  process.env.MCP_HTTP_MAX_ATTEMPTS = "3";
  let calls = 0;
  global.fetch = async () => {
    calls++;
    throw new Error("network down");
  };
  await assert.rejects(() => streamableMcpPost("https://x", {}, {}), /network down/);
  assert.equal(calls, 3);
});

test("recovers from a transient network error", async () => {
  process.env.MCP_HTTP_RETRY_BASE_MS = "0";
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNRESET");
    return jsonResponse(200, { ok: 1 });
  };
  const res = await streamableMcpPost("https://x", {}, {});
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});
