/**
 * SSRF guard for outbound MCP URLs.
 *
 * The Tableau MCP base URL can be set per-user from App Home. Without a guard, a
 * low-privilege workspace member could point it at an internal target and make
 * the server fetch it on their behalf — classic SSRF. The highest-value target
 * is the cloud metadata endpoint (169.254.169.254), which on many hosts hands
 * out IAM credentials; loopback and RFC-1918 hosts expose internal services.
 *
 * This module classifies a URL's host and blocks:
 *   - non-http(s) schemes, and (for user input) plain http://
 *   - IP literals in loopback / private / link-local / ULA / unspecified /
 *     multicast / reserved ranges (IPv4 and IPv6, incl. IPv4-mapped IPv6)
 *   - internal-only hostnames: localhost, *.localhost, *.internal, *.local
 *
 * Limitation: this validates the *literal* host, not the DNS resolution, so it
 * does not by itself stop DNS-rebinding (a public name that resolves to a
 * private IP). Combined with `redirect: "error"` on the fetch and re-validation
 * on every request, it closes the practical attacker-controlled vectors here.
 */

const net = require("net");

/** @param {string} host */
function stripIpv6Brackets(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * @param {number[]} o - four octets
 * @returns {string|null} reason if this IPv4 is in a blocked range, else null
 */
function blockedIpv4Reason(o) {
  const [a, b] = o;
  if (a === 0) return "unspecified/this-network address";
  if (a === 10) return "private (10.0.0.0/8) address";
  if (a === 127) return "loopback (127.0.0.0/8) address";
  if (a === 169 && b === 254) return "link-local (169.254.0.0/16 — cloud metadata) address";
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16.0.0/12) address";
  if (a === 192 && b === 168) return "private (192.168.0.0/16) address";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT (100.64.0.0/10) address";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15) address";
  if (a === 192 && b === 0 && o[2] === 0) return "IETF protocol assignments (192.0.0.0/24) address";
  if (a >= 224) return "multicast/reserved (>=224.0.0.0) address";
  return null;
}

/** Parse a dotted-quad string to octets, or null if not a valid IPv4 literal. */
function parseIpv4(host) {
  if (net.isIPv4(host) !== true) return null;
  const parts = host.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups. Handles `::` compression
 * and a trailing embedded IPv4 (e.g. `::ffff:1.2.3.4`). Returns null if unparseable.
 * @param {string} host
 * @returns {number[]|null}
 */
function expandIpv6(host) {
  if (net.isIPv6(host) !== true) return null;
  let s = host;
  let tailV4 = null;

  // Trailing embedded IPv4 → convert to two 16-bit groups.
  const v4Match = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Match) {
    const v4 = parseIpv4(v4Match[1]);
    if (!v4) return null;
    tailV4 = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, v4Match.index);
    s = s.replace(/:$/, s.endsWith("::") ? ":" : ""); // keep a lone "::" intact
  }

  const hasCompression = s.includes("::");
  const [headStr, tailStr = ""] = hasCompression ? s.split("::") : [s, ""];
  const head = headStr ? headStr.split(":").filter(Boolean) : [];
  const tail = tailStr ? tailStr.split(":").filter(Boolean) : [];

  const hexGroups = (arr) => arr.map((g) => parseInt(g, 16) & 0xffff);
  const headG = hexGroups(head);
  const tailG = hexGroups(tail);
  const tailAll = tailV4 ? [...tailG, ...tailV4] : tailG;

  let groups;
  if (hasCompression) {
    const missing = 8 - headG.length - tailAll.length;
    if (missing < 0) return null;
    groups = [...headG, ...new Array(missing).fill(0), ...tailAll];
  } else {
    groups = [...headG, ...tailAll];
  }
  if (groups.length !== 8) return null;
  return groups;
}

/**
 * @param {number[]} g - eight 16-bit groups
 * @returns {string|null} reason if blocked, else null
 */
function blockedIpv6Reason(g) {
  const allZeroButLast = g.slice(0, 7).every((x) => x === 0);
  if (allZeroButLast && g[7] === 1) return "IPv6 loopback (::1)";
  if (g.every((x) => x === 0)) return "IPv6 unspecified (::)";

  const first = g[0];
  const firstByte = first >> 8;
  if (first >= 0xfe80 && first <= 0xfebf) return "IPv6 link-local (fe80::/10)";
  if (firstByte === 0xfc || firstByte === 0xfd) return "IPv6 unique-local (fc00::/7)";
  if (firstByte === 0xff) return "IPv6 multicast (ff00::/8)";

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) — check embedded IPv4.
  const first5Zero = g.slice(0, 5).every((x) => x === 0);
  if (first5Zero && (g[5] === 0xffff || g[5] === 0)) {
    const o = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
    const v4Reason = blockedIpv4Reason(o);
    if (v4Reason) return `IPv4-in-IPv6 ${v4Reason}`;
  }
  return null;
}

/** Hostnames that always denote an internal target regardless of DNS. */
function blockedHostnameReason(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost";
  if (h.endsWith(".internal")) return "an .internal hostname";
  if (h.endsWith(".local")) return "a .local (mDNS) hostname";
  return null;
}

/**
 * Classify a URL host for SSRF safety.
 * @param {string} hostname - URL.hostname (may be bracketed IPv6)
 * @returns {{ safe: true } | { safe: false, reason: string }}
 */
function classifyHost(hostname) {
  const host = stripIpv6Brackets(String(hostname || "").trim());
  if (!host) return { safe: false, reason: "empty host" };

  const v4 = parseIpv4(host);
  if (v4) {
    const reason = blockedIpv4Reason(v4);
    return reason ? { safe: false, reason } : { safe: true };
  }
  const v6 = expandIpv6(host);
  if (v6) {
    const reason = blockedIpv6Reason(v6);
    return reason ? { safe: false, reason } : { safe: true };
  }
  const nameReason = blockedHostnameReason(host);
  if (nameReason) return { safe: false, reason: nameReason };
  return { safe: true };
}

/**
 * Validate a user-supplied MCP base URL. Strict: requires https and a public
 * host. No escape hatch — this input is attacker-controllable (App Home).
 * @param {string} raw
 * @returns {{ ok: true, url: string|null } | { ok: false, error: string }}
 */
function validateUserMcpUrl(raw) {
  const s = (raw || "").trim();
  if (!s) return { ok: true, url: null };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "URL must use https://" };
  const cls = classifyHost(u.hostname);
  if (!cls.safe) return { ok: false, error: `URL host is not allowed (${cls.reason})` };
  return { ok: true, url: s.replace(/\/$/, "") };
}

/**
 * Assert a URL is safe to fetch server-side, or throw. Called on every outbound
 * request (re-validation on read). `allowPrivate` lets an operator permit a
 * private/internal *deployment default* via TABLEAU_MCP_ALLOW_PRIVATE=1; user
 * overrides are already blocked at write time, so this only relaxes the env URL.
 * @param {string} urlString
 * @param {{ allowPrivate?: boolean }} [opts]
 */
function assertSafeOutboundUrl(urlString, opts = {}) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error("Refusing to fetch an invalid MCP URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Refusing to fetch non-http(s) MCP URL (${u.protocol})`);
  }
  if (opts.allowPrivate) return;
  const cls = classifyHost(u.hostname);
  if (!cls.safe) {
    throw new Error(`Refusing to fetch MCP URL with disallowed host: ${cls.reason}`);
  }
}

/** True when the operator has opted into private/internal MCP targets. */
function allowPrivateMcpTargets() {
  return process.env.TABLEAU_MCP_ALLOW_PRIVATE === "1";
}

module.exports = {
  classifyHost,
  validateUserMcpUrl,
  assertSafeOutboundUrl,
  allowPrivateMcpTargets,
};
