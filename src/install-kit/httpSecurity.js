/**
 * Lightweight, dependency-free HTTP hardening for the Express app that backs
 * Bolt's ExpressReceiver. Two pieces, both safe to run in front of every route:
 *
 *  1. securityHeaders() — a small set of defensive response headers. The only
 *     browser-facing routes here are the OAuth install/callback pages
 *     (/slack/install, /slack/oauthcallback); these headers (nosniff, DENY
 *     framing, referrer trim, and HSTS over TLS) cost nothing on the JSON
 *     webhook/event routes and close the easy clickjacking/sniffing gaps on the
 *     install flow. No CSP is set — it could break the Slack-hosted OAuth
 *     redirect — and no `cors` package is added (there is no browser API to
 *     expose cross-origin).
 *
 *  2. rateLimiter() — an in-memory, per-IP fixed-window limiter used ONLY on the
 *     secret-in-path trigger routes (Tableau refresh, daily brief, triage
 *     admission). The path secret is compared timing-safely, but nothing else
 *     throttles online guessing of a low-entropy secret; this caps the guess
 *     rate. Defaults are generous (real callers are EventBridge/Tableau firing a
 *     handful of times a day), and the whole thing is opt-outable. In-memory is
 *     sufficient: these routes run on a single always-on web process, and a
 *     restart simply resets the window (fail-open, never blocks a real deploy).
 */

/**
 * Attach conservative security headers to every response.
 * Always on — there is no configuration and nothing it can break on the JSON
 * routes. HSTS is only meaningful (and only sent) once the request arrived over
 * TLS, which it always does behind Heroku/App Runner's HTTPS front door.
 * @returns {import("express").RequestHandler}
 */
function securityHeaders() {
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    // Only assert HSTS when the edge terminated TLS (x-forwarded-proto=https) or
    // the connection itself is encrypted — never on plain-http local dev.
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    if (proto === "https" || req.secure) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

/**
 * Client IP for rate limiting. The LEFTMOST X-Forwarded-For entry is whatever the
 * caller sent and is trivially spoofable (rotate it per request and the limiter
 * never trips). Each trusted proxy APPENDS the address it saw, so the entry
 * TRUST_PROXY_HOPS from the right is the one the platform vouches for. Heroku's
 * router (and App Runner's front end) is one hop → default 1 → the rightmost entry.
 * TRUST_PROXY_HOPS=0 ignores X-Forwarded-For entirely (direct exposure, no proxy).
 */
function clientIp(req) {
  const raw = Number(process.env.TRUST_PROXY_HOPS);
  const hops = Number.isInteger(raw) && raw >= 0 ? raw : 1;
  const chain = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const xff = hops > 0 && chain.length ? chain[Math.max(0, chain.length - hops)] : "";
  return xff || req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Per-IP fixed-window rate limiter (in-memory). Returns a middleware that 429s a
 * client once it exceeds `max` requests within `windowMs`.
 *
 * Set RATE_LIMIT_DISABLED=1 to bypass entirely (returns a pass-through), e.g. for
 * a load test. Tunable via RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS.
 *
 * @param {object} [opts]
 * @param {number} [opts.max]        max requests per window per IP (default 30)
 * @param {number} [opts.windowMs]   window length in ms (default 60000)
 * @param {() => number} [opts.now]  clock injection for tests
 * @returns {import("express").RequestHandler}
 */
function rateLimiter(opts = {}) {
  if (String(process.env.RATE_LIMIT_DISABLED || "") === "1") {
    return (req, res, next) => next();
  }
  const max = Number(opts.max ?? process.env.RATE_LIMIT_MAX ?? 30);
  const windowMs = Number(opts.windowMs ?? process.env.RATE_LIMIT_WINDOW_MS ?? 60000);
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  // ip -> { count, resetAt }
  const hits = new Map();

  return function rateLimitMiddleware(req, res, next) {
    const t = now();
    const ip = clientIp(req);
    let entry = hits.get(ip);
    if (!entry || t >= entry.resetAt) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;

    // Opportunistic sweep so the Map can't grow unbounded under many distinct
    // IPs — evict windows that have already expired. Cheap: only when the map is
    // large, and only expired entries are removed.
    if (hits.size > 1000) {
      for (const [k, v] of hits) {
        if (t >= v.resetAt) hits.delete(k);
      }
    }

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ ok: false, error: "rate limit exceeded" });
    }
    next();
  };
}

module.exports = { securityHeaders, rateLimiter, clientIp };
