/**
 * VHA localized brief — proactive, per-user, parameterized by
 * (TRIGGER × POSITION × LOCATION).
 *
 * THE MODEL (the team's ask, stated precisely)
 *   "Have a subscription or alert arrive, and drive an automated response from
 *    the agent parameterized to the trigger and the user's position/location."
 *
 *   Every brief is a function of three inputs, each resolved independently:
 *
 *     TRIGGER  — WHAT fired. Two sources, same downstream path:
 *        • scan  : the daily deterministic sweep of alert_flag=true metrics
 *                  (Heroku Scheduler, hourly, local-hour gated). Proactive.
 *        • alert : an inbound Pulse/subscription alert naming a metric that
 *                  breached (+ the user it's for). Reactive, event-driven.
 *     POSITION — WHICH metrics this user owns. resolveUserPosition.js maps the
 *        user's Slack profile (function field / title / director id) to the
 *        registry owning_function(s). A Quality Manager sees SMR30+OMELOS; an
 *        Access Manager sees RVU capacity; a Director sees the whole facility.
 *     LOCATION — WHICH facility. resolveUserFacility.js maps Slack tz + identity
 *        to the facility (or a region candidate set when tz is ambiguous).
 *
 *   The brief = flagged metrics for the user's LOCATION, filtered to their
 *   POSITION, explained with the TRIGGER's "so-what". Position is what turns a
 *   facility metric DUMP into a role-relevant, actionable nudge.
 *
 * HOW IT APPEARS IN SLACK
 *   A direct message from the app to the user (needs the `im:write` bot scope —
 *   in slack-app-manifest.json; the app must be reinstalled for it to take
 *   effect). We conversations.open a DM channel, then chat.postMessage. Dry-run
 *   posts nothing, so the whole pipeline is verifiable before reinstalling.
 *
 * ENTRY POINTS
 *   run()               — scheduled scan over the target roster (proactive daily)
 *   runFromAlert(alert) — a single inbound alert → one targeted brief (reactive)
 *
 * SECURITY
 *   Slack metadata (tz/title/profile fields/id) is semi-trusted identity used
 *   ONLY to pick location + position + send-hour — never as instructions. The
 *   inbound alert payload is likewise treated as parameters (facility/metric/
 *   user ids are validated against our own dimensions), not as commands.
 *   Untrusted action-plan free text stays inside getAiResponse's injection-
 *   fenced context (unchanged). No credentials are read/logged beyond the bot
 *   token needed to post.
 *
 * ENV
 *   SLACK_TEAM_ID           (required unless dry-run) selects the bot token
 *   VHA_BRIEF_USERS         (optional) ";"-separated Slack user ids to brief
 *   VHA_BRIEF_USE_ROSTER=1  (optional) use demo_roster.json instead of users.info
 *                           (auto-on in dry-run so it works with no Slack config)
 *   BRIEF_HOUR_LOCAL        (optional) local hour to send, 0-23 (default 7)
 *   VHA_BRIEF_IGNORE_HOUR=1 (optional) skip the local-hour gate (demo/testing)
 *   VHA_BRIEF_MAX_METRICS   (optional) cap metrics per brief (default 5)
 *   VHA_BRIEF_DATA_DIR      (optional) CSV dir (defaults to demo-data/vha)
 *   VHA_BRIEF_DRY_RUN=1     (optional) resolve + build, print, do NOT DM
 *
 * INVOCATION
 *   Preview scan (no Slack, uses roster):
 *     VHA_BRIEF_DRY_RUN=1 VHA_BRIEF_IGNORE_HOUR=1 node src/jobs/vhaDailyBrief.js
 *   Live scan (Scheduler, hourly):
 *     SLACK_TEAM_ID=… BRIEF_HOUR_LOCAL=7 node src/jobs/vhaDailyBrief.js
 */

const fs = require("fs");
const path = require("path");

// Pure helpers reused from the digest (parse/trigger/narrative) + the two
// resolvers. These are require-safe (no Prisma/Slack at import).
const {
  parseCsv,
  findFlaggedMetrics,
  buildSoWhatPrompt,
  buildSkillContext,
} = require("./vhaLocalizedDigest");
const { resolveFromSlackUser } = require("./resolveUserFacility");
const {
  resolveFunctionsFromSlackUser,
  positionCoversFunction,
  ALL_FUNCTIONS,
} = require("./resolveUserPosition");
const { metricView, viewDeepLink, fetchMetricViewImage } = require("./vhaMetricViews");
const { postThreadFileUploads } = require("../slack/postThreadFileUploads");

// Attach the per-metric Tableau view (deep link always; a rendered PNG when we
// can reach the MCP). Live runs fetch+upload; a dry-run can opt in with
// VHA_BRIEF_FETCH_VIEWS=1 to prove the image round-trip without DMing.
const FETCH_VIEWS = process.env.VHA_BRIEF_FETCH_VIEWS === "1";

const DATA_DIR =
  process.env.VHA_BRIEF_DATA_DIR ||
  path.join(__dirname, "..", "..", "demo-data", "vha");
const BRIEF_HOUR_LOCAL = Number.isFinite(Number(process.env.BRIEF_HOUR_LOCAL))
  ? Number(process.env.BRIEF_HOUR_LOCAL)
  : 7;
const IGNORE_HOUR = process.env.VHA_BRIEF_IGNORE_HOUR === "1";
const MAX_METRICS = Number(process.env.VHA_BRIEF_MAX_METRICS) || 5;
const DRY_RUN = process.env.VHA_BRIEF_DRY_RUN === "1";
// In dry-run we default to the synthetic roster so the pipeline runs with no
// Slack config; a live run uses users.info unless VHA_BRIEF_USE_ROSTER=1.
const USE_ROSTER = process.env.VHA_BRIEF_USE_ROSTER === "1" || DRY_RUN;

function readCsv(name) {
  return parseCsv(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
}

function loadDims() {
  const snapshots = readCsv("vha_metric_snapshots.csv");
  const plans = readCsv("vha_action_plans.csv");
  const registry = readCsv("vha_metric_registry.csv");
  const facilities = readCsv("vha_facilities.csv");
  const planIndex = new Map();
  for (const p of plans) planIndex.set(`${p.facility_name}|${p.metric_key}`, p);
  const fnByMetric = new Map(registry.map((m) => [m.metric_key, m.owning_function]));
  return { snapshots, plans, registry, facilities, planIndex, fnByMetric };
}

function loadRoster() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "demo_roster.json"), "utf8"));
    return Array.isArray(doc?.users) ? doc.users : [];
  } catch (err) {
    console.warn(`[vha-brief] could not load demo_roster.json: ${err?.message || err}`);
    return [];
  }
}

/**
 * Local hour for a user in their IANA tz, right now. Uses Intl (no external
 * dep) so DST is handled correctly. Returns 0-23, or null if tz is unusable.
 * `nowMs` is injectable for tests.
 */
function localHourInTz(tz, nowMs = Date.now()) {
  if (!tz) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
    const h = Number(fmt.format(new Date(nowMs)));
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the (POSITION × LOCATION) for a user and select the metric rows that
 * belong in their brief for a given TRIGGER. Pure — no Slack, no LLM.
 *
 * @param {object} user         Slack users.info user object (or roster subset)
 * @param {object} dims         from loadDims()
 * @param {object} trigger      { kind:"scan" } | { kind:"alert", metricKeys:string[] }
 * @returns {{
 *   facilityResolution, positionResolution, facility, functions,
 *   rows: object[],          // metric snapshot rows selected for the brief
 *   skipped: null | {reason:string}
 * }}
 */
function selectBriefRows(user, dims, trigger = { kind: "scan" }) {
  const { snapshots, facilities, registry, fnByMetric } = dims;

  const loc = resolveFromSlackUser(user, facilities);
  const pos = resolveFunctionsFromSlackUser(user, { registry, facilities });

  if (!loc.facility) {
    return { facilityResolution: loc, positionResolution: pos, facility: null,
      functions: pos.functions, rows: [], skipped: { reason: `location: ${loc.reason}` } };
  }
  if (pos.tier === "none" || (Array.isArray(pos.functions) && pos.functions.length === 0)) {
    // No position to filter by. Rather than dump the whole facility, skip —
    // the caller can opt into a facility-wide fallback if desired.
    return { facilityResolution: loc, positionResolution: pos, facility: loc.facility,
      functions: pos.functions, rows: [], skipped: { reason: `position: ${pos.reason}` } };
  }

  const facilityName = loc.facility.facility_name;
  const { latest, flaggedByFacility } = findFlaggedMetrics(snapshots);

  let rows;
  if (trigger.kind === "alert") {
    // TRIGGER = alert: the alert names the metric(s) that breached. Pull those
    // exact rows for this facility+latest month (validated against our data).
    const want = new Set(trigger.metricKeys || []);
    rows = snapshots.filter(
      (r) => r.facility_name === facilityName && r.period_month === latest && want.has(r.metric_key),
    );
  } else {
    // TRIGGER = scan: this facility's alert_flag=true metrics (already ranked).
    rows = (flaggedByFacility.get(facilityName) || []).slice();
  }

  // POSITION filter: keep only metrics whose owning_function the user owns.
  rows = rows.filter((r) => positionCoversFunction(pos.functions, fnByMetric.get(r.metric_key)));
  rows = rows.slice(0, MAX_METRICS);

  return { facilityResolution: loc, positionResolution: pos, facility: loc.facility,
    functions: pos.functions, rows, latest, skipped: null };
}

/** Compose the Slack mrkdwn body for a resolved brief. Pure (narratives passed in). */
function composeBriefBody({ facility, positionResolution, latest, trigger, sections }) {
  const posLabel = positionResolution.functions === ALL_FUNCTIONS
    ? "facility-wide (director)"
    : positionResolution.functions.join(", ");
  const triggerLabel = trigger.kind === "alert"
    ? "Alert" : "Daily brief";
  const parts = [
    `:sunny: *${triggerLabel} — ${facility.facility_name}*  (${facility.visn}, ${facility.region})`,
    `_As of ${latest}. Role: ${posLabel}. ${sections.length} metric(s) need your attention._`,
  ];
  for (const { snap, narrative, viewLink, viewImage } of sections) {
    parts.push(
      `\n:rotating_light: *${snap.metric_caption}* — *${snap.rag_status}*` +
        (snap.alert_reason ? ` (${snap.alert_reason})` : ""),
      narrative,
    );
    if (viewLink) {
      // The rendered chart (when present) uploads under the message; the link is
      // always offered so the user can open the live, interactive view.
      const chart = viewImage ? "chart below · " : "";
      parts.push(`:bar_chart: ${chart}<${viewLink}|Open ${snap.metric_caption} in Tableau>`);
    }
  }
  return parts.join("\n");
}

/**
 * Turn selected rows into narrated sections. When `web` is present the agent
 * writes each so-what live (Tableau MCP); in dry-run it emits the deterministic
 * facts. Shared by both entry points.
 */
async function narrateSections({ rows, facility, dims, latest, ctx }) {
  const { planIndex, registry } = dims;
  const sections = [];
  for (const snap of rows) {
    const plan = planIndex.get(`${facility.facility_name}|${snap.metric_key}`) || null;
    let narrative;
    if (ctx.web && ctx.getAiResponse) {
      try {
        const response = await ctx.getAiResponse({
          userMessage: buildSoWhatPrompt({ snap, plan, registry, latest }),
          skillContext: buildSkillContext({ snap, plan }),
          systemPromptSections: [],
          teamId: ctx.teamId,
          tableauMcpBaseUrl: ctx.tableauMcpBaseUrl,
          useFullModel: true,
        });
        narrative = response.text;
      } catch (err) {
        console.error(`[vha-brief] getAiResponse failed for ${facility.facility_name}/${snap.metric_key}: ${err?.message || err}`);
        narrative = `_(narrative unavailable — ${snap.alert_reason})_`;
      }
    } else {
      narrative = `_(dry-run so-what placeholder)_  value ${snap.value} vs target ${snap.target}; ` +
        `${snap.status_change}; ${snap.alert_reason}.`;
    }

    // Attach the metric's Tableau view. The deep link is pure (always available
    // when the metric is mapped); the rendered PNG is fetched live (or in a
    // dry-run opting into FETCH_VIEWS) and uploaded under the DM by deliver().
    const vmap = metricView(snap.metric_key);
    const viewLink = vmap ? viewDeepLink(vmap.contentUrl) : null;
    let viewImage = null;
    if (vmap && (ctx.web || FETCH_VIEWS)) {
      viewImage = await fetchMetricViewImage(snap.metric_key, {
        metricCaption: snap.metric_caption,
        facilityName: facility.facility_name,
        tableauMcpBaseUrl: ctx.tableauMcpBaseUrl,
      });
      console.log(`[vha-brief] view ${snap.metric_key}: link=${viewLink ? "yes" : "no"}, image=${viewImage ? `${viewImage.buffer.length}b` : "none"}`);
    }
    sections.push({ snap, narrative, viewLink, viewImage });
  }
  return sections;
}

/** Deliver a composed body to a user's DM (or preview in dry-run). */
async function deliver({ userId, body, facility, sections = [], ctx }) {
  const images = sections.map((s) => s.viewImage).filter((v) => v && v.buffer);
  if (!ctx.web) {
    const imgNote = images.length ? `\n[+ ${images.length} metric view PNG(s): ${images.map((i) => i.filename).join(", ")}]` : "";
    console.log(`\n===== would DM ${userId} (${facility.facility_name}) =====\n${body}${imgNote}\n`);
    return true;
  }
  const opened = await ctx.web.conversations.open({ users: userId });
  const dmChannel = opened?.channel?.id;
  if (!dmChannel) {
    console.warn(`[vha-brief] conversations.open returned no channel for ${userId}; skipping`);
    return false;
  }
  const { text: notifyText, blocks } = ctx.mrkdwnStringToBlocks(body);
  const posted = await ctx.web.chat.postMessage({ channel: dmChannel, text: notifyText, blocks, unfurl_links: false });

  // Upload the rendered metric charts in a thread under the brief so the DM stays
  // readable. Non-fatal: the brief text has already delivered, and each section
  // still carries an "Open in Tableau" link even if the image upload fails.
  if (images.length) {
    try {
      await postThreadFileUploads(ctx.web, {
        channelId: dmChannel,
        threadTs: posted?.ts || null,
        uploads: images.map((i) => ({ buffer: i.buffer, filename: i.filename, title: i.title })),
      });
    } catch (err) {
      console.error(`[vha-brief] metric-view upload failed for ${userId}: ${err?.message || err}`);
    }
  }
  return true;
}

/** Build the shared live-context (bot token, LLM core, mcp url) or a dry ctx. */
async function buildCtx() {
  if (DRY_RUN) return { web: null };
  const { WebClient } = require("@slack/web-api");
  const { getAiResponse } = require("../assistant/respond");
  const { getInstallation } = require("../install-kit/installationStore");
  const { resolveTableauMcpUrl } = require("../assistant/tableauMcpClient");
  const { mrkdwnStringToBlocks } = require("../slack/mrkdwnToBlocks");

  const teamId = process.env.SLACK_TEAM_ID;
  if (!teamId) throw new Error("SLACK_TEAM_ID is required to select the bot token (or set VHA_BRIEF_DRY_RUN=1).");
  const installation = await getInstallation({ teamId });
  const botToken = installation?.bot?.token;
  if (!botToken) throw new Error(`No bot token for team ${teamId} — is the app installed there?`);

  return {
    web: new WebClient(botToken),
    getAiResponse,
    mrkdwnStringToBlocks,
    teamId,
    tableauMcpBaseUrl: resolveTableauMcpUrl(undefined),
  };
}

/** Fetch a user object either from the roster fixture or live users.info. */
async function getUser(userId, ctx, roster) {
  if (USE_ROSTER || !ctx.web) {
    return roster.find((u) => u.id === userId) || null;
  }
  try {
    const res = await ctx.web.users.info({ user: userId });
    return res?.user || null;
  } catch (err) {
    console.warn(`[vha-brief] users.info failed for ${userId}: ${err?.message || err}`);
    return null;
  }
}

/** Live: resolve an email to a Slack user id via users.lookupByEmail (needs users:read.email). */
async function lookupUserIdByEmail(web, email) {
  try {
    const res = await web.users.lookupByEmail({ email });
    return res?.user?.id || null;
  } catch (err) {
    console.warn(`[vha-brief] lookupByEmail failed for ${email}: ${err?.data?.error || err?.message || err}`);
    return null;
  }
}

/**
 * Parse VHA_BRIEF_BINDINGS — a JSON array pinning specific people to a
 * facility+role for testing (so a real Slack account that isn't in the
 * synthetic roster resolves deterministically instead of via tz/title guesses):
 *   [{"email":"jgillmore@salesforce.com","facilityName":"Phoenix, AZ HCS","role":"director"}]
 * `role`: "director" (facility-wide, ALL functions) or an owning_function name
 * (e.g. "Quality Manager"). Either `email` or `slackId` may identify the person.
 */
function parseBindings() {
  const raw = process.env.VHA_BRIEF_BINDINGS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn(`[vha-brief] VHA_BRIEF_BINDINGS is not valid JSON, ignoring: ${err?.message || err}`);
    return [];
  }
}

/**
 * Apply a resolved binding (now carrying a concrete slackId) to the dimensions.
 * DIRECTOR bindings rebind that facility's director_user to the person's Slack
 * id, so the ALREADY-TESTED Tier-1 resolver paths fire naturally: location
 * (facilities.find(director_user===id)) and position (director id → ALL).
 * Returns a NEW facilities array (does not mutate the loaded dims).
 */
function applyDirectorBinding(facilities, { slackId, facilityName }) {
  return facilities.map((f) =>
    f.facility_name === facilityName ? { ...f, director_user: slackId } : f,
  );
}

/**
 * For a NON-director (role) binding, synthesize the profile field the position
 * resolver reads + pin the facility, so a real user resolves to exactly that
 * role/facility. Returns an augmented copy of the user object.
 */
function applyRoleBindingToUser(user, { facilityName, role }, facilities) {
  const fac = facilities.find((f) => f.facility_name === facilityName);
  return {
    ...user,
    profile: {
      ...(user.profile || {}),
      fields: {
        ...((user.profile && user.profile.fields) || {}),
        _vhaBindFacility: { label: "VHA Facility", value: fac ? fac.director_user : facilityName },
        _vhaBindFunction: { label: "VHA Function", value: role },
      },
    },
  };
}

/**
 * Resolve VHA_BRIEF_BINDINGS to concrete Slack ids and apply them.
 *   - director bindings rebind facility.director_user → the person's id.
 *   - role bindings are returned as a per-id augmentation map (applied in the
 *     loop, since they mutate the user object, not the facilities).
 * Emails are resolved via users.lookupByEmail (skipped in dry-run — supply
 * slackId there, or rely on the roster). Returns { facilities, boundUserIds,
 * roleBindingByUserId }.
 */
async function resolveBindings(ctx, facilities) {
  const bindings = parseBindings();
  let outFacilities = facilities;
  const boundUserIds = [];
  const roleBindingByUserId = new Map();

  for (const b of bindings) {
    let slackId = b.slackId || null;
    if (!slackId && b.email && ctx.web) slackId = await lookupUserIdByEmail(ctx.web, b.email);
    if (!slackId) {
      console.warn(`[vha-brief] binding for ${b.email || "(no email)"} unresolved (no slackId; ${ctx.web ? "lookup failed" : "dry-run/no web"}) — skipping`);
      continue;
    }
    const isDirector = String(b.role || "director").toLowerCase() === "director";
    if (isDirector) {
      outFacilities = applyDirectorBinding(outFacilities, { slackId, facilityName: b.facilityName });
    } else {
      roleBindingByUserId.set(slackId, { facilityName: b.facilityName, role: b.role });
    }
    boundUserIds.push(slackId);
    console.log(`[vha-brief] bound ${b.email || slackId} → ${b.facilityName} as ${b.role || "director"} (${slackId})`);
  }
  return { facilities: outFacilities, boundUserIds, roleBindingByUserId };
}

/** Choose the target user id list for a scan. Bound users take precedence. */
function targetUserIds(roster, facilities, boundUserIds = []) {
  const explicit = (process.env.VHA_BRIEF_USERS || "")
    .split(";").map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  // A test binding scopes the run to just those people (avoids DMing every
  // synthetic director id, which wouldn't resolve to real Slack users anyway).
  if (boundUserIds.length) return [...new Set(boundUserIds)];
  if (USE_ROSTER && roster.length) return roster.map((u) => u.id);
  // Live default: the facilities' directors (facility-wide briefs).
  return facilities.map((f) => f.director_user).filter(Boolean);
}

/* ────────────────────────── ENTRY POINT 1: SCAN ────────────────────────── */

// Durable dedupe lives in briefDeliveryStore.js (Postgres via Prisma). It is
// PER-METRIC: a metric that is new or has WORSENED (new contentSig) is sent; a
// metric already delivered unchanged this reporting month is suppressed. Rows
// are marked sent only AFTER a successful DM, so a post failure doesn't
// permanently suppress. Survives dyno restarts/deploys, unlike the old
// in-memory Set. Fail-open: if the DB is down, briefs still deliver.
const briefStore = require("./briefDeliveryStore");

/**
 * Scheduled/triggered scan over the target roster.
 * @param {object} [opts]
 * @param {boolean} [opts.ignoreHour]  bypass the local-hour gate (webhook: the
 *   data-refresh event IS the trigger, so deliver now regardless of clock)
 * @param {boolean} [opts.dedupe]      consult the durable store: send only new/
 *   worsened metrics, suppress ones already delivered this month
 * @param {string}  [opts.reason]      label for logs (e.g. "datasource refresh")
 */
async function run({ ignoreHour = IGNORE_HOUR, dedupe = false, reason = "scheduled scan" } = {}) {
  const dims = loadDims();
  const roster = USE_ROSTER ? loadRoster() : [];
  const ctx = await buildCtx();

  // Apply any explicit test bindings (email/id → facility+role). Director
  // bindings rebind dims.facilities; role bindings augment the user in-loop.
  const { facilities: boundFacilities, boundUserIds, roleBindingByUserId } = await resolveBindings(ctx, dims.facilities);
  dims.facilities = boundFacilities;

  const userIds = targetUserIds(roster, dims.facilities, boundUserIds);

  console.log(`[vha-brief] SCAN (${reason}) — candidates=${userIds.length}; ` +
    `hour=${ignoreHour ? "(gate off)" : BRIEF_HOUR_LOCAL}; dedupe=${dedupe}; roster=${USE_ROSTER}; bindings=${boundUserIds.length}; dryRun=${DRY_RUN}`);

  let sent = 0, skippedHour = 0, skippedDup = 0, skippedNoFacility = 0, skippedNoPosition = 0, skippedNoAlerts = 0;

  for (const userId of userIds) {
    let user = await getUser(userId, ctx, roster);
    if (!user) continue;

    // Role binding (non-director) augments the user's profile so the position
    // resolver pins them to the bound facility + owning_function.
    if (roleBindingByUserId.has(userId)) {
      user = applyRoleBindingToUser(user, roleBindingByUserId.get(userId), dims.facilities);
    }

    if (!ignoreHour && localHourInTz(user.tz) !== BRIEF_HOUR_LOCAL) { skippedHour++; continue; }

    const sel = selectBriefRows(user, dims, { kind: "scan" });
    if (sel.skipped) {
      if (sel.skipped.reason.startsWith("location")) { skippedNoFacility++; console.log(`[vha-brief] ${userId}: ${sel.skipped.reason}`); }
      else { skippedNoPosition++; console.log(`[vha-brief] ${userId}: ${sel.skipped.reason}`); }
      continue;
    }
    if (sel.rows.length === 0) { skippedNoAlerts++; continue; } // nothing off-target in their lane

    // Per-metric durable dedupe: keep only new/worsened metrics.
    let rows = sel.rows;
    let sigByMetric = null;
    if (dedupe) {
      const teamId = ctx.teamId || process.env.SLACK_TEAM_ID || null;
      const filtered = await briefStore.filterUnsent({ teamId, userId, periodMonth: sel.latest, rows: sel.rows });
      sigByMetric = filtered.sigByMetric;
      if (filtered.toSend.length === 0) { skippedDup++; continue; } // all already delivered, unchanged
      rows = filtered.toSend;
    }

    const sections = await narrateSections({ rows, facility: sel.facility, dims, latest: sel.latest, ctx });
    const body = composeBriefBody({ facility: sel.facility, positionResolution: sel.positionResolution,
      latest: sel.latest, trigger: { kind: "scan" }, sections });
    if (await deliver({ userId, body, facility: sel.facility, sections, ctx })) {
      sent++;
      if (dedupe) {
        // Mark ONLY after a successful DM, so a post failure can retry next run.
        const teamId = ctx.teamId || process.env.SLACK_TEAM_ID || null;
        await briefStore.markBatchSent({ teamId, userId, facilityName: sel.facility.facility_name, periodMonth: sel.latest, rows, sigByMetric });
      }
    }
  }

  console.log(`[vha-brief] SCAN done — ${sent} brief(s) ${DRY_RUN ? "previewed" : "sent"}; ` +
    `skipped: hour=${skippedHour}, dup=${skippedDup}, no-facility=${skippedNoFacility}, no-position=${skippedNoPosition}, no-alerts=${skippedNoAlerts}.`);
  return { sent, skippedHour, skippedDup, skippedNoFacility, skippedNoPosition, skippedNoAlerts };
}

/* ─────────────────────── ENTRY POINT 2: ALERT-DRIVEN ────────────────────── */

/**
 * React to a single inbound alert (Pulse / Tableau subscription webhook, etc.)
 * and drive ONE targeted brief. The alert is the TRIGGER; position + location
 * still come from the user's Slack metadata, so the same metric produces a
 * different framing for a Quality Manager vs a Director.
 *
 * @param {object} alert
 *   { userId: string,                     // who to brief (required)
 *     metricKeys?: string[],              // metric(s) that fired (default: any flagged)
 *     facilityName?: string }             // optional override; else resolved from user
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
async function runFromAlert(alert) {
  if (!alert?.userId) throw new Error("runFromAlert requires alert.userId");
  const dims = loadDims();
  const roster = USE_ROSTER ? loadRoster() : [];
  const ctx = await buildCtx();

  const user = await getUser(alert.userId, ctx, roster);
  if (!user) return { sent: false, reason: `no user ${alert.userId}` };

  const trigger = { kind: "alert", metricKeys: alert.metricKeys || [] };

  // If the alert names no metrics, fall back to the user's flagged set (scan-like)
  // but still through the alert framing.
  const effectiveTrigger = (trigger.metricKeys.length ? trigger : { kind: "scan" });
  const sel = selectBriefRows(user, dims, effectiveTrigger);

  console.log(`[vha-brief] ALERT — user=${alert.userId}; metrics=${(alert.metricKeys || []).join(",") || "(flagged)"}; ` +
    `location=${sel.facility?.facility_name || "?"}; position=${JSON.stringify(sel.functions)}; roster=${USE_ROSTER}; dryRun=${DRY_RUN}`);

  if (sel.skipped) return { sent: false, reason: sel.skipped.reason };
  if (sel.rows.length === 0) {
    return { sent: false, reason: "alerted metric(s) not in this user's position/facility, or not flagged" };
  }

  const sections = await narrateSections({ rows: sel.rows, facility: sel.facility, dims, latest: sel.latest, ctx });
  const body = composeBriefBody({ facility: sel.facility, positionResolution: sel.positionResolution,
    latest: sel.latest, trigger: { kind: "alert" }, sections });
  const ok = await deliver({ userId: alert.userId, body, facility: sel.facility, sections, ctx });
  return { sent: ok };
}

/* ────────────────── ENTRY POINT 3: DATASOURCE-REFRESH WEBHOOK ───────────── */

// Data sources whose refresh should trigger briefs. The snapshots source is the
// Pulse fact — when it refreshes, alert_flag has been recomputed, so that's the
// moment to (re)brief. Matched case-insensitively against the webhook's
// resource_name (and resource_luid, so a rename doesn't break it). Other sources
// (facilities/registry/action-plans) are dimensions — their refresh doesn't move
// a metric, so we ignore them to avoid needless fan-out.
const REFRESH_TRIGGER_SOURCES = [
  { name: "VHA Metric Snapshots", luid: "7b92fd7b-cdc2-4142-8594-ecb77a827be9" },
];

function isTriggeringRefresh(payload) {
  const name = String(payload?.resource_name || "").trim().toLowerCase();
  const luid = String(payload?.resource_luid || "").trim().toLowerCase();
  return REFRESH_TRIGGER_SOURCES.some(
    (s) => (s.name && s.name.toLowerCase() === name) || (s.luid && s.luid.toLowerCase() === luid),
  );
}

/**
 * React to a Tableau "DatasourceRefreshSucceeded" webhook. New data has landed
 * and alert_flag is recomputed, so this is the natural push-trigger that
 * REPLACES the polling scheduler: run the scan now (clock-independent), deduped
 * so multiple refresh events in the same reporting month don't double-post.
 *
 * @param {object} payload  Tableau webhook body:
 *   { resource:"EXTRACTS", event_type, resource_name, resource_luid, site_luid, created_at }
 * @returns {Promise<{triggered:boolean, reason?:string, result?:object}>}
 */
async function runFromRefresh(payload) {
  // Only DatasourceRefreshSucceeded moves the data. Started/Failed are no-ops
  // (Failed means the extract data did NOT change — briefing on stale data would
  // be misleading).
  const eventType = payload?.event_type || "";
  if (eventType && eventType !== "DatasourceRefreshSucceeded") {
    return { triggered: false, reason: `ignored event_type ${eventType}` };
  }
  // Empty payload = Tableau's "Test" button. Ack without briefing.
  if (!payload || Object.keys(payload).length === 0) {
    return { triggered: false, reason: "empty payload (webhook test)" };
  }
  if (!isTriggeringRefresh(payload)) {
    return { triggered: false, reason: `resource not a trigger source (${payload?.resource_name || payload?.resource_luid || "?"})` };
  }

  const result = await run({
    ignoreHour: true,   // the refresh IS the trigger — deliver now, not at 7am
    dedupe: true,       // don't re-post the same month's brief on repeat refreshes
    reason: `datasource refresh: ${payload.resource_name || payload.resource_luid}`,
  });
  return { triggered: true, result };
}

if (require.main === module) {
  // CLI: `node vhaDailyBrief.js`           → scan (hour-gated, no dedupe)
  //      `node vhaDailyBrief.js --daily`   → scheduled daily scan (hour gate OFF, dedupe ON)
  //      `node vhaDailyBrief.js --alert '{"userId":"U_PHX_QM","metricKeys":["SMR30"]}'`
  //      `node vhaDailyBrief.js --refresh '{"event_type":"DatasourceRefreshSucceeded","resource_name":"VHA Metric Snapshots"}'`
  const alertArgIdx = process.argv.indexOf("--alert");
  const refreshArgIdx = process.argv.indexOf("--refresh");
  const daily = process.argv.includes("--daily");
  // Parse a JSON CLI arg with a clean error instead of an unhandled synchronous
  // throw that escapes the .catch below (operator convenience).
  const parseJsonArg = (raw, flag) => {
    try {
      return JSON.parse(raw || "{}");
    } catch (err) {
      console.error(`[vha-brief] ${flag} expects valid JSON: ${err.message}`);
      process.exit(1);
    }
  };
  let invocation;
  if (alertArgIdx !== -1) {
    invocation = runFromAlert(parseJsonArg(process.argv[alertArgIdx + 1], "--alert"));
  } else if (refreshArgIdx !== -1) {
    invocation = runFromRefresh(parseJsonArg(process.argv[refreshArgIdx + 1], "--refresh"));
  } else if (daily) {
    // Heroku Scheduler runs this once/day at a fixed UTC time, so the scheduler
    // IS the send-time gate → skip the per-user local-hour gate. Dedupe ON so a
    // same-day re-run (or an overlapping refresh webhook) never double-posts the
    // same month's brief. To scale to many timezones, switch the Scheduler to
    // HOURLY and drop --daily so BRIEF_HOUR_LOCAL gates each user's own 7am.
    invocation = run({ ignoreHour: true, dedupe: true, reason: "scheduled daily scan" });
  } else {
    invocation = run();
  }
  invocation
    .then((r) => { if (r) console.log("[vha-brief] result:", JSON.stringify(r)); process.exit(0); })
    .catch((err) => { console.error("[vha-brief] fatal:", err?.message || err); process.exit(1); });
}

module.exports = {
  run,
  runFromAlert,
  runFromRefresh,
  isTriggeringRefresh,
  selectBriefRows,
  composeBriefBody,
  localHourInTz,
  targetUserIds,
  loadDims,
  loadRoster,
  parseBindings,
  applyDirectorBinding,
  applyRoleBindingToUser,
};
