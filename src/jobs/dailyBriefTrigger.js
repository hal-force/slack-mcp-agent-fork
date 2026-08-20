/**
 * Scheduled daily-brief HTTP trigger.
 *
 * WHY THIS EXISTS (AWS App Runner has no cron / release phase)
 *   On Heroku the daily brief is fired by the Scheduler add-on running
 *   `node src/jobs/vhaDailyBrief.js --daily`. App Runner runs a single always-on
 *   web process with no built-in scheduler, so on AWS the cadence comes from
 *   EventBridge Scheduler, which can only invoke an HTTP endpoint (or an AWS API).
 *   This route is that endpoint: EventBridge POSTs here once a day and we run the
 *   very same `run({ ignoreHour:true, dedupe:true })` the CLI `--daily` flag runs.
 *
 *   Because it fans out Slack DMs, it must be authenticated. Tableau/EventBridge
 *   send no signature we can verify, so — exactly like the Tableau refresh webhook
 *   (see tableauWebhook.js) — authenticity rests on a SECRET IN THE PATH compared
 *   timing-safely. Without VHA_DAILY_JOB_SECRET set the route refuses to arm, so
 *   we never expose an unauthenticated DM-fanout endpoint.
 *
 * FAST-ACK CONTRACT
 *   The scan calls the LLM per candidate metric and can take minutes. EventBridge
 *   treats non-2xx / slow responses as failures and retries, which would double
 *   fire the scan. So we ACK 200 immediately and run the scan in the background
 *   (the durable per-metric dedupe ledger defends against any overlap anyway).
 */

const crypto = require("crypto");
const { safeEqual } = require("./tableauWebhook");

/**
 * Mount the daily-brief trigger route on a Bolt ExpressReceiver.
 * @param {import("@slack/bolt").ExpressReceiver} receiver
 * @param {object} [deps]
 * @param {(opts:object)=>Promise<any>} [deps.run]  injectable for tests
 * @param {object} [deps.logger]
 */
function registerDailyBriefTrigger(receiver, deps = {}) {
  const logger = deps.logger || console;
  const secret = process.env.VHA_DAILY_JOB_SECRET;

  if (!secret) {
    logger.warn?.(
      "[daily-brief] VHA_DAILY_JOB_SECRET not set — scheduled daily-brief trigger is DISABLED. " +
        "Set it and point EventBridge Scheduler at POST /jobs/vha-daily/<secret> to enable the daily scan.",
    );
    return { mounted: false };
  }

  // Lazy-require the job so importing this module in tests doesn't pull in
  // Slack/LLM deps unless the route actually fires.
  const run = deps.run || ((opts) => require("./vhaDailyBrief").run(opts));

  const express = require("express");
  const router = receiver.router;
  // No body is required (EventBridge can POST empty), but parse one if sent so a
  // future payload (e.g. {dryRun:true}) is available. Tiny cap — this is a ping.
  const jsonParser = express.json({ limit: "8kb" });

  router.post("/jobs/vha-daily/:secret", jsonParser, async (req, res) => {
    if (!safeEqual(req.params.secret || "", secret)) {
      // Same response as an unknown route — don't confirm the path exists.
      logger.warn?.("[daily-brief] rejected request with bad/missing secret");
      return res.status(404).end();
    }

    // ACK IMMEDIATELY (fast-ack) — then scan in the background.
    res.status(200).json({ ok: true });

    // Same invocation as the `--daily` CLI flag: hour gate OFF (the schedule is
    // the send-time gate), dedupe ON (a retry or overlapping refresh webhook must
    // never double-post the same month's brief).
    Promise.resolve()
      .then(() => run({ ignoreHour: true, dedupe: true, reason: "scheduled daily scan (http trigger)" }))
      .then((r) => {
        logger.info?.(`[daily-brief] scheduled scan handled: ${JSON.stringify(r || {})}`);
      })
      .catch((err) => logger.error?.("[daily-brief] scheduled scan failed:", err?.message || err));
  });

  logger.info?.("[daily-brief] armed at POST /jobs/vha-daily/<secret>");
  return { mounted: true };
}

module.exports = { registerDailyBriefTrigger };
