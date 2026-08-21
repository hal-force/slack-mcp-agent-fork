const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("http");
const { securityHeaders, rateLimiter, clientIp } = require("../src/install-kit/httpSecurity");

/** Mount `middleware` in front of a trivial 200 route and return a POST helper. */
async function withServer(t, middleware, { extraHeaders } = {}) {
  const app = express();
  if (Array.isArray(middleware)) middleware.forEach((m) => app.use(m));
  else app.use(middleware);
  app.post("/ping", (req, res) => res.status(200).json({ ok: true }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  t.after(() => server.close());

  const post = async (headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders, ...headers },
      body: "{}",
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  return { post, port };
}

// ---------------------------------------------------------------------------
// securityHeaders()
// ---------------------------------------------------------------------------

test("securityHeaders sets nosniff / DENY / no-referrer on every response", async (t) => {
  const { post } = await withServer(t, securityHeaders());
  const res = await post();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});

test("securityHeaders sends HSTS only when TLS terminated at the edge (x-forwarded-proto=https)", async (t) => {
  const { post } = await withServer(t, securityHeaders());
  const overTls = await post({ "x-forwarded-proto": "https" });
  assert.match(
    overTls.headers.get("strict-transport-security") || "",
    /max-age=31536000; includeSubDomains/,
  );
  // Plain http (no forwarded-proto): no HSTS, so local dev is never pinned to TLS.
  const plain = await post();
  assert.equal(plain.headers.get("strict-transport-security"), null);
});

test("securityHeaders reads only the first x-forwarded-proto hop", async (t) => {
  const { post } = await withServer(t, securityHeaders());
  const res = await post({ "x-forwarded-proto": "https, http" });
  assert.ok(res.headers.get("strict-transport-security"), "first hop https → HSTS");
});

// ---------------------------------------------------------------------------
// rateLimiter()
// ---------------------------------------------------------------------------

test("rateLimiter allows up to max, then 429s with a Retry-After", async (t) => {
  const { post } = await withServer(t, rateLimiter({ max: 3, windowMs: 60000 }), {
    extraHeaders: { "x-forwarded-for": "203.0.113.7" },
  });
  for (let i = 0; i < 3; i++) {
    const ok = await post();
    assert.equal(ok.status, 200, `request ${i + 1} within limit`);
  }
  const blocked = await post();
  assert.equal(blocked.status, 429, "4th request over the limit");
  const retry = Number(blocked.headers.get("retry-after"));
  assert.ok(retry >= 1 && retry <= 60, `Retry-After in-window (got ${retry})`);
  assert.deepEqual(JSON.parse(blocked.text), { ok: false, error: "rate limit exceeded" });
});

test("rateLimiter windows are per-IP (distinct x-forwarded-for get independent budgets)", async (t) => {
  const { post } = await withServer(t, rateLimiter({ max: 1, windowMs: 60000 }));
  const a1 = await post({ "x-forwarded-for": "198.51.100.1" });
  const b1 = await post({ "x-forwarded-for": "198.51.100.2" });
  assert.equal(a1.status, 200, "IP A first request ok");
  assert.equal(b1.status, 200, "IP B first request ok (separate bucket)");
  const a2 = await post({ "x-forwarded-for": "198.51.100.1" });
  assert.equal(a2.status, 429, "IP A second request blocked");
});

test("rateLimiter resets after the window elapses (injected clock)", async (t) => {
  let now = 1_000_000;
  const { post } = await withServer(
    t,
    rateLimiter({ max: 1, windowMs: 1000, now: () => now }),
    { extraHeaders: { "x-forwarded-for": "203.0.113.9" } },
  );
  assert.equal((await post()).status, 200, "first in window");
  assert.equal((await post()).status, 429, "second over limit");
  now += 1001; // advance past the window
  assert.equal((await post()).status, 200, "new window → allowed again");
});

test("rateLimiter is bypassed when RATE_LIMIT_DISABLED=1", async (t) => {
  const prev = process.env.RATE_LIMIT_DISABLED;
  process.env.RATE_LIMIT_DISABLED = "1";
  t.after(() => {
    if (prev === undefined) delete process.env.RATE_LIMIT_DISABLED;
    else process.env.RATE_LIMIT_DISABLED = prev;
  });
  const { post } = await withServer(t, rateLimiter({ max: 1, windowMs: 60000 }), {
    extraHeaders: { "x-forwarded-for": "203.0.113.11" },
  });
  for (let i = 0; i < 5; i++) {
    assert.equal((await post()).status, 200, `disabled → request ${i + 1} passes`);
  }
});

test("rateLimiter reads env defaults for max/window when opts omitted", async (t) => {
  const prevMax = process.env.RATE_LIMIT_MAX;
  process.env.RATE_LIMIT_MAX = "2";
  t.after(() => {
    if (prevMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = prevMax;
  });
  const { post } = await withServer(t, rateLimiter(), {
    extraHeaders: { "x-forwarded-for": "203.0.113.13" },
  });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 429, "3rd over RATE_LIMIT_MAX=2");
});

// ---------------------------------------------------------------------------
// clientIp()
// ---------------------------------------------------------------------------

test("clientIp prefers the first x-forwarded-for hop, else falls back", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }), "1.2.3.4");
  assert.equal(clientIp({ headers: {}, ip: "9.9.9.9" }), "9.9.9.9");
  assert.equal(
    clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.5" } }),
    "10.0.0.5",
  );
  assert.equal(clientIp({ headers: {} }), "unknown");
});
