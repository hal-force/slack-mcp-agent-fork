/**
 * Triage admission HTTP trigger — "a patient was admitted → post to #nurse-triage".
 *
 * WHY THIS EXISTS
 *   The demo scenario is event-driven: an admission event (from an EHR, a form,
 *   or a manual poke) should cause the agent to announce the new patient in the
 *   nurse-triage channel and post a ranked nurse recommendation. App Runner has no
 *   cron and Slack sends no event for this, so — exactly like the daily-brief and
 *   Tableau-refresh triggers — the cadence comes from an authenticated HTTP POST.
 *
 * SAFETY
 *   This endpoint POSTS INTO A SLACK CHANNEL, so it must be authenticated and it
 *   must be OFF by default. Authenticity rests on a SECRET IN THE PATH compared
 *   timing-safely (same design as tableauWebhook / dailyBriefTrigger). Without
 *   TRIAGE_ADMISSION_SECRET set, the route refuses to arm — we never expose an
 *   unauthenticated channel-posting endpoint. It also requires AGENTS_ENABLED to
 *   be on, so the multi-agent surface stays fully gated.
 *
 * REQUEST
 *   POST /triage/admission/<secret>
 *   body: { "patient_id": "PT0123", "channel": "C...", "unit": "ICU-A" }
 *   - channel defaults to TRIAGE_CHANNEL_ID when omitted.
 *   Fast-acks 200, then posts the admission notice + recommendation card.
 */

const { safeEqual } = require("./tableauWebhook");
const { agentsEnabled } = require("../agents/supervisor");

/**
 * Build a channel poster bound to the workspace's bot token.
 *
 * WHY NOT app.client: this is an OAuth multi-workspace app (installationStore),
 * so the Bolt App's own `client` carries NO bot token — chat.postMessage through
 * it fails `not_authed`. We resolve the installation's bot token the same way the
 * daily-brief job does (getInstallation({teamId}) → WebClient) and post with that.
 *
 * @param {{ teamId: string }} args
 * @returns {Promise<(msg:object)=>Promise<any>>}
 */
async function defaultResolvePoster({ teamId }) {
  if (!teamId) {
    throw new Error("cannot resolve a bot token to post: no teamId (set SLACK_TEAM_ID or pass team_id)");
  }
  const { getInstallation } = require("../install-kit/installationStore");
  const installation = await getInstallation({ teamId });
  const botToken = installation?.bot?.token;
  if (!botToken) {
    throw new Error(`no bot token for team ${teamId} — is the app installed there?`);
  }
  const { WebClient } = require("@slack/web-api");
  const client = new WebClient(botToken);
  return (msg) => client.chat.postMessage(msg);
}

/**
 * @param {import("@slack/bolt").ExpressReceiver} receiver
 * @param {object} [deps]
 * @param {(args:{teamId:string})=>Promise<(msg:object)=>Promise<any>>} [deps.resolvePoster]
 *   Resolve the channel poster (test seam). Defaults to a bot-token-bound WebClient.
 * @param {(msg:object)=>Promise<any>} [deps.postMessage]
 *   A ready-made poster (shortcut test seam; wins over resolvePoster).
 * @param {(params:object, d:object)=>Promise<any>} [deps.handleAdmission]  injectable for tests
 * @param {{ run:(env:object)=>Promise<any> }} [deps.specialist]
 * @param {object} [deps.logger]
 */
function registerTriageAdmissionTrigger(receiver, deps = {}) {
  const logger = deps.logger || console;
  const secret = process.env.TRIAGE_ADMISSION_SECRET;

  if (!secret) {
    logger.info?.(
      "[triage-admission] TRIAGE_ADMISSION_SECRET not set — admission trigger DISABLED. " +
        "Set it (and AGENTS_ENABLED=1) and POST /triage/admission/<secret> to enable.",
    );
    return { mounted: false };
  }

  const handleAdmission = deps.handleAdmission || ((p, d) => require("../agents/triageAdmission").handleAdmission(p, d));
  // Poster resolution: tests inject a ready poster (deps.postMessage) or a resolver
  // (deps.resolvePoster); production resolves the installation's bot token per request.
  const resolvePoster =
    typeof deps.resolvePoster === "function"
      ? deps.resolvePoster
      : typeof deps.postMessage === "function"
        ? async () => deps.postMessage
        : defaultResolvePoster;

  const express = require("express");
  const jsonParser = express.json({ limit: "16kb" });

  receiver.router.post("/triage/admission/:secret", jsonParser, async (req, res) => {
    if (!safeEqual(req.params.secret || "", secret)) {
      logger.warn?.("[triage-admission] rejected request with bad/missing secret");
      return res.status(404).end(); // don't confirm the path exists
    }
    if (!agentsEnabled()) {
      logger.warn?.("[triage-admission] AGENTS_ENABLED is off — refusing to post");
      return res.status(409).json({ ok: false, error: "multi-agent layer disabled (set AGENTS_ENABLED=1)" });
    }

    const body = req.body || {};
    const patientId = String(body.patient_id || body.patientId || "").trim();
    const channel = String(body.channel || process.env.TRIAGE_CHANNEL_ID || "").trim();
    const unit = body.unit ? String(body.unit).trim() : undefined;
    const teamId = String(body.team_id || process.env.SLACK_TEAM_ID || "").trim();

    if (!patientId) return res.status(400).json({ ok: false, error: "patient_id is required" });
    if (!channel) {
      return res.status(400).json({ ok: false, error: "channel is required (set TRIAGE_CHANNEL_ID or pass channel)" });
    }

    // Fast-ack, then resolve the bot token + post in the background (posting can call
    // the specialist LLM). A resolution/post failure is logged, not returned (we've acked).
    res.status(200).json({ ok: true, patient_id: patientId, channel });

    Promise.resolve()
      .then(async () => {
        const postMessage = await resolvePoster({ teamId });
        return handleAdmission(
          { patientId, channel, unit },
          { postMessage, specialist: deps.specialist || undefined },
        );
      })
      .then((r) => logger.info?.(`[triage-admission] posted for ${patientId}: top=${r?.ranking?.[0]?.nurse_id || "none"}`))
      .catch((err) => logger.error?.("[triage-admission] failed:", err?.message || err));
  });

  logger.info?.("[triage-admission] armed at POST /triage/admission/<secret>");
  return { mounted: true };
}

module.exports = { registerTriageAdmissionTrigger, defaultResolvePoster };
