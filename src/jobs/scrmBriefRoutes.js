/**
 * SCRM localized-brief HTTP routes — the SCRM analog of tableauWebhook.js +
 * dailyBriefTrigger.js, combined. Mounts two independently-armed routes on the
 * Bolt ExpressReceiver, both pointing at src/jobs/scrmRiskBrief.js:
 *
 *   POST /webhooks/tableau/scrm-refresh/:secret   → scrmRiskBrief.runFromRefresh
 *   POST /jobs/scrm-daily/:secret                 → scrmRiskBrief.run (daily scan)
 *
 * PARALLEL & NON-DESTRUCTIVE
 *   These paths are DISTINCT from the VHA routes (/webhooks/tableau/refresh,
 *   /jobs/vha-daily). Mounting them changes nothing about the VHA brief or the
 *   Slack events endpoint; the two brief pipelines coexist on one app.
 *
 * SECRETS (secret-in-the-path, timing-safe — same model as the VHA routes)
 *   • Refresh webhook: reuses TABLEAU_WEBHOOK_SECRET (one Tableau site, one
 *     shared webhook secret; the PATH is what distinguishes SCRM from VHA).
 *   • Daily trigger:   SCRM_DAILY_JOB_SECRET, falling back to VHA_DAILY_JOB_SECRET
 *     so a single scheduler secret can drive both scans if desired.
 *   Each route refuses to arm without its secret, so we never expose an
 *   unauthenticated DM-fanout endpoint.
 *
 * FAST-ACK
 *   Both routes ACK 200 immediately and run the (LLM-narrated, slow) brief in the
 *   background — identical contract to the VHA routes, and the durable per-metric
 *   dedupe ledger defends against retries / overlapping refreshes.
 */

const { safeEqual } = require("./tableauWebhook");

/**
 * Mount both SCRM brief routes. Each arms independently based on its secret.
 * @param {import("@slack/bolt").ExpressReceiver} receiver
 * @param {object} [deps]
 * @param {(payload:object)=>Promise<any>} [deps.runFromRefresh] injectable for tests
 * @param {(opts:object)=>Promise<any>}    [deps.run]            injectable for tests
 * @param {object} [deps.logger]
 * @returns {{refresh:{mounted:boolean}, daily:{mounted:boolean}}}
 */
function registerScrmBriefRoutes(receiver, deps = {}) {
  const logger = deps.logger || console;
  const express = require("express");
  const { rateLimiter } = require("../install-kit/httpSecurity");
  const router = receiver.router;

  const result = { refresh: { mounted: false }, daily: { mounted: false } };

  /* ── Route 1: Tableau datasource-refresh webhook → runFromRefresh ────────── */
  const refreshSecret = process.env.TABLEAU_WEBHOOK_SECRET;
  if (!refreshSecret) {
    logger.warn?.(
      "[scrm-brief] TABLEAU_WEBHOOK_SECRET not set — SCRM refresh webhook is DISABLED. " +
        "Set it and register the Tableau webhook at /webhooks/tableau/scrm-refresh/<secret>.",
    );
  } else {
    // Lazy-require so importing this module (tests) doesn't pull in Slack/LLM deps.
    const runFromRefresh =
      deps.runFromRefresh || ((payload) => require("./scrmRiskBrief").runFromRefresh(payload));
    const jsonParser = express.json({ limit: "16kb" });
    const limit = rateLimiter();

    router.post("/webhooks/tableau/scrm-refresh/:secret", limit, jsonParser, async (req, res) => {
      if (!safeEqual(req.params.secret || "", refreshSecret)) {
        logger.warn?.("[scrm-brief] refresh: rejected request with bad/missing secret");
        return res.status(404).end();
      }
      const payload = req.body || {};
      res.status(200).json({ ok: true }); // fast-ack, then brief in background
      Promise.resolve()
        .then(() => runFromRefresh(payload))
        .then((r) => {
          if (r?.triggered) logger.info?.(`[scrm-brief] refresh handled: ${JSON.stringify(r.result)}`);
          else logger.info?.(`[scrm-brief] refresh ignored: ${r?.reason || "unknown"}`);
        })
        .catch((err) => logger.error?.("[scrm-brief] runFromRefresh failed:", err?.message || err));
    });
    logger.info?.("[scrm-brief] armed at POST /webhooks/tableau/scrm-refresh/<secret>");
    result.refresh.mounted = true;
  }

  /* ── Route 2: scheduled daily scan → run({ignoreHour,dedupe}) ────────────── */
  const dailySecret = process.env.SCRM_DAILY_JOB_SECRET || process.env.VHA_DAILY_JOB_SECRET;
  if (!dailySecret) {
    logger.warn?.(
      "[scrm-brief] neither SCRM_DAILY_JOB_SECRET nor VHA_DAILY_JOB_SECRET set — SCRM daily trigger is DISABLED. " +
        "Set one and point the scheduler at POST /jobs/scrm-daily/<secret>.",
    );
  } else {
    const run = deps.run || ((opts) => require("./scrmRiskBrief").run(opts));
    const jsonParser = express.json({ limit: "8kb" });
    const limit = rateLimiter();

    router.post("/jobs/scrm-daily/:secret", limit, jsonParser, async (req, res) => {
      if (!safeEqual(req.params.secret || "", dailySecret)) {
        logger.warn?.("[scrm-brief] daily: rejected request with bad/missing secret");
        return res.status(404).end();
      }
      res.status(200).json({ ok: true }); // fast-ack, then scan in background
      Promise.resolve()
        .then(() => run({ ignoreHour: true, dedupe: true, reason: "scheduled daily scan (http trigger)" }))
        .then((r) => logger.info?.(`[scrm-brief] scheduled scan handled: ${JSON.stringify(r || {})}`))
        .catch((err) => logger.error?.("[scrm-brief] scheduled scan failed:", err?.message || err));
    });
    logger.info?.("[scrm-brief] armed at POST /jobs/scrm-daily/<secret>");
    result.daily.mounted = true;
  }

  return result;
}

module.exports = { registerScrmBriefRoutes };
