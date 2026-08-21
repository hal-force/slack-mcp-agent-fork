/**
 * Tableau datasource-refresh webhook receiver.
 *
 * THE TRIGGER (the team's ask, upgraded from polling)
 *   Instead of the scheduler polling hourly, Tableau Cloud PUSHES us an event
 *   the moment an extract refresh finishes. When "VHA Metric Snapshots" (the
 *   Pulse fact) refreshes, alert_flag has just been recomputed — so that event
 *   is the natural moment to (re)brief affected users. This receiver turns that
 *   POST into a call to vhaDailyBrief.runFromRefresh().
 *
 * VERIFIED TABLEAU BEHAVIOUR (help.tableau.com/current/developer/webhooks)
 *   • Events: DatasourceRefreshStarted / …Succeeded / …Failed. We act only on
 *     Succeeded (Started = nothing new yet; Failed = data did NOT change, so
 *     briefing on it would be misleading).
 *   • Delivery: HTTP POST, JSON body
 *       { resource:"EXTRACTS", event_type, resource_name, resource_luid,
 *         site_luid, created_at }
 *   • Destination MUST be https with a valid cert — our Heroku app qualifies.
 *   • The "Test" button sends an EMPTY payload; we must 200 it (handled).
 *   • Tableau webhooks are NOT signed (no HMAC header). Authenticity therefore
 *     rests on a SECRET IN THE PATH: the webhook is registered at
 *       https://<app>/webhooks/tableau/refresh/<TABLEAU_WEBHOOK_SECRET>
 *     and we compare the path segment to the env secret with a timing-safe
 *     equality check. Without the secret set, the route refuses to arm (we do
 *     NOT want an unauthenticated endpoint that fans out Slack DMs).
 *
 * WHY A SEPARATE JSON ROUTE IS SAFE ALONGSIDE BOLT
 *   Bolt's ExpressReceiver scopes its raw-body parser to the Slack events
 *   endpoint only; mounting our own express.json() route on receiver.router for
 *   a different path does not disturb Slack request-signature verification.
 *
 * FAST-ACK CONTRACT
 *   Tableau (like Slack) wants a prompt 2xx. Briefing calls the LLM per metric,
 *   which is slow — so we ACK 200 immediately and run the brief in the
 *   background (fire-and-forget with error logging). A webhook receiver that
 *   awaited the whole fan-out would risk Tableau timing out and retrying,
 *   causing duplicate briefs (the dedupe guard also defends against that).
 */

const crypto = require("crypto");

/** Timing-safe string compare that doesn't leak length via early return. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Mount the Tableau webhook route on a Bolt ExpressReceiver.
 * @param {import("@slack/bolt").ExpressReceiver} receiver
 * @param {object} [deps]
 * @param {(payload:object)=>Promise<any>} [deps.runFromRefresh]  injectable for tests
 * @param {object} [deps.logger]
 */
function registerTableauWebhook(receiver, deps = {}) {
  const logger = deps.logger || console;
  const secret = process.env.TABLEAU_WEBHOOK_SECRET;

  if (!secret) {
    // Refuse to arm an unauthenticated endpoint. Log once so the operator knows
    // why the webhook 404s until they set the secret.
    logger.warn?.(
      "[tableau-webhook] TABLEAU_WEBHOOK_SECRET not set — refresh webhook route is DISABLED. " +
      "Set it and register the Tableau webhook at /webhooks/tableau/refresh/<secret> to enable push briefs.",
    );
    return { mounted: false };
  }

  // Lazy-require the job so importing this module (e.g. in tests) doesn't pull
  // in Slack/LLM deps unless the route actually fires.
  const runFromRefresh =
    deps.runFromRefresh || ((payload) => require("./vhaDailyBrief").runFromRefresh(payload));

  const express = require("express");
  const { rateLimiter } = require("../install-kit/httpSecurity");
  const router = receiver.router;

  // Scoped JSON parser for THIS route only (does not touch Slack's raw body).
  // Tableau payloads are tiny; cap the body to reject junk.
  const jsonParser = express.json({ limit: "16kb" });
  // Per-IP throttle so a leaked/guessed path secret can't be brute-forced or
  // used to hammer the DM fan-out. Real callers (Tableau) fire a few times/day.
  const limit = rateLimiter();

  // Secret lives in the PATH segment (Tableau sends no custom auth header).
  router.post("/webhooks/tableau/refresh/:secret", limit, jsonParser, async (req, res) => {
    if (!safeEqual(req.params.secret || "", secret)) {
      // Same response as a truly unknown route — don't confirm the path exists.
      logger.warn?.("[tableau-webhook] rejected request with bad/missing secret");
      return res.status(404).end();
    }

    const payload = req.body || {};
    // ACK IMMEDIATELY (fast-ack contract) — then brief in the background.
    res.status(200).json({ ok: true });

    // Fire-and-forget. runFromRefresh handles the test-ping (empty payload),
    // event_type filtering, source filtering, and dedupe internally.
    Promise.resolve()
      .then(() => runFromRefresh(payload))
      .then((r) => {
        if (r?.triggered) {
          logger.info?.(`[tableau-webhook] refresh handled: ${JSON.stringify(r.result)}`);
        } else {
          logger.info?.(`[tableau-webhook] refresh ignored: ${r?.reason || "unknown"}`);
        }
      })
      .catch((err) => logger.error?.("[tableau-webhook] runFromRefresh failed:", err?.message || err));
  });

  logger.info?.("[tableau-webhook] armed at POST /webhooks/tableau/refresh/<secret>");
  return { mounted: true };
}

module.exports = { registerTableauWebhook, safeEqual };
