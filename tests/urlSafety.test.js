const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyHost,
  validateUserMcpUrl,
  assertSafeOutboundUrl,
} = require("../src/assistant/urlSafety");

// ---- classifyHost: public hosts pass ----

test("public hostnames and IPs are safe", () => {
  for (const h of [
    "example.com",
    "federal-tableau-mcp-81e8ca899174.herokuapp.com",
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:2800:220:1:248:1893:25c8:1946",
  ]) {
    assert.equal(classifyHost(h).safe, true, `${h} should be safe`);
  }
});

// ---- classifyHost: blocked IPv4 ranges ----

test("blocks IPv4 loopback / private / link-local / metadata", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata — the crown jewel
    "0.0.0.0",
    "100.64.1.1",
    "224.0.0.1",
  ];
  for (const h of blocked) {
    assert.equal(classifyHost(h).safe, false, `${h} should be blocked`);
  }
});

test("does not over-block near-miss public IPv4", () => {
  for (const h of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "169.253.0.1"]) {
    assert.equal(classifyHost(h).safe, true, `${h} should be allowed`);
  }
});

// ---- classifyHost: blocked IPv6 ----

test("blocks IPv6 loopback / link-local / ULA / unspecified", () => {
  for (const h of ["::1", "[::1]", "fe80::1", "fc00::1", "fd12:3456::1", "::", "ff02::1"]) {
    assert.equal(classifyHost(h).safe, false, `${h} should be blocked`);
  }
});

test("blocks IPv4-mapped IPv6 pointing at a private/metadata address", () => {
  for (const h of ["::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1"]) {
    assert.equal(classifyHost(h).safe, false, `${h} should be blocked`);
  }
});

// ---- classifyHost: blocked internal hostnames ----

test("blocks internal-only hostnames regardless of DNS", () => {
  for (const h of ["localhost", "LOCALHOST", "foo.localhost", "db.internal", "printer.local"]) {
    assert.equal(classifyHost(h).safe, false, `${h} should be blocked`);
  }
});

// ---- validateUserMcpUrl ----

test("validateUserMcpUrl accepts a public https URL and strips trailing slash", () => {
  const r = validateUserMcpUrl("https://mcp.example.com/tableau-mcp/");
  assert.deepEqual(r, { ok: true, url: "https://mcp.example.com/tableau-mcp" });
});

test("validateUserMcpUrl treats empty input as 'no override'", () => {
  assert.deepEqual(validateUserMcpUrl(""), { ok: true, url: null });
  assert.deepEqual(validateUserMcpUrl("   "), { ok: true, url: null });
});

test("validateUserMcpUrl rejects http://", () => {
  const r = validateUserMcpUrl("http://mcp.example.com");
  assert.equal(r.ok, false);
  assert.match(r.error, /https/);
});

test("validateUserMcpUrl rejects SSRF targets", () => {
  for (const u of [
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data/",
    "https://localhost:8080/mcp",
    "https://[::1]/mcp",
    "https://db.internal/mcp",
    "https://10.1.2.3/mcp",
  ]) {
    const r = validateUserMcpUrl(u);
    assert.equal(r.ok, false, `${u} should be rejected`);
    assert.match(r.error, /not allowed/);
  }
});

test("validateUserMcpUrl rejects a malformed URL", () => {
  const r = validateUserMcpUrl("not a url");
  assert.equal(r.ok, false);
});

// ---- assertSafeOutboundUrl ----

test("assertSafeOutboundUrl passes public https and throws on private", () => {
  assert.doesNotThrow(() => assertSafeOutboundUrl("https://mcp.example.com/x"));
  assert.throws(() => assertSafeOutboundUrl("https://169.254.169.254/"), /disallowed host/);
  assert.throws(() => assertSafeOutboundUrl("ftp://example.com/"), /non-http/);
  assert.throws(() => assertSafeOutboundUrl("://bad"), /invalid/i);
});

test("assertSafeOutboundUrl allows private targets only when opted in", () => {
  assert.throws(() => assertSafeOutboundUrl("https://10.0.0.5/mcp"));
  assert.doesNotThrow(() => assertSafeOutboundUrl("https://10.0.0.5/mcp", { allowPrivate: true }));
});
