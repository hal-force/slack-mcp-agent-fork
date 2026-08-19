/**
 * Resolve a Slack user to the VA facility (and location context) their daily
 * brief should cover — the "takes into account a user's location + Slack
 * metadata" half of the automated daily-brief design.
 *
 * WHY A DEDICATED RESOLVER
 *   The daily brief is localized: each administrator should get THEIR
 *   facility's off-target metrics, not the national dump. "Which facility?"
 *   is answered from Slack metadata (`users.info`) in tiers, most-authoritative
 *   first, so the demo works with zero manual config but degrades gracefully:
 *
 *   TIER 1 — explicit binding (authoritative). A Slack user is bound to a
 *     facility by id. In this demo the facilities dimension's `director_user`
 *     (e.g. "U_DIR_PHX") IS the Slack user id, so a direct id match is exact.
 *     In production this is a profile custom field ("VHA Facility") or a small
 *     mapping table — same shape, swap the source.
 *
 *   TIER 2 — location inference (Slack tz + locale). `users.info` returns
 *     `tz` ("America/Phoenix"), `tz_label`, and `locale` ("en-US"). We map the
 *     IANA tz to candidate US states, then to facilities. When exactly one
 *     facility matches, we use it. When several share a tz (three CA HCS all
 *     read "America/Los_Angeles"), we return the CANDIDATE SET so the caller
 *     can brief at the VISN/region grain or ask the user to disambiguate once.
 *
 *   The timezone is ALSO the schedule key: the brief is meant to arrive at a
 *     local hour (e.g. 07:00 in the user's tz), which is why the scheduler
 *     fans out per-tz rather than firing once in UTC (see DAILY-BRIEF-DESIGN.md).
 *
 * SECURITY / TRUST
 *   Slack metadata is semi-trusted identity, not instructions. This module
 *   only READS tz/locale/id to pick a facility; it never treats profile text
 *   as a command. (The untrusted action-plan free text is fenced downstream in
 *   getAiResponse, unchanged.)
 *
 * PURE + TESTABLE
 *   The mapping logic is pure (no Slack/Prisma). `resolveFromSlackUser()` takes
 *   a plain `users.info` user object + the facilities rows, so it unit-tests
 *   without credentials. `fetchAndResolve()` is the thin live wrapper.
 */

// IANA timezone -> US state codes that timezone can imply for VA facilities.
// Kept intentionally small — only the states present in the facilities dim.
// America/Phoenix is AZ-only (no DST); America/Denver covers NM/UT/CO;
// America/Los_Angeles covers CA/OR; America/Chicago covers OK; etc.
const TZ_TO_STATES = {
  "America/New_York": ["NY"],
  "America/Chicago": ["OK"],
  "America/Denver": ["NM", "UT", "CO"],
  "America/Phoenix": ["AZ"],
  "America/Los_Angeles": ["CA", "OR"],
  "America/Anchorage": ["AK"],
};

/**
 * @param {object} user  a Slack `users.info` user object (or its subset)
 * @param {Array<object>} facilities  rows from vha_facilities (facility_key,
 *   facility_name, state, visn, region, director_user, ...)
 * @returns {{
 *   facility: object|null,        // the single resolved facility, if unambiguous
 *   candidates: object[],         // all facilities consistent with the metadata
 *   tier: "explicit"|"location"|"none",
 *   tz: string|null, tzLabel: string|null, locale: string|null,
 *   reason: string                // human-readable how-resolved, for logs/brief header
 * }}
 */
function resolveFromSlackUser(user, facilities) {
  const tz = user?.tz || null;
  const tzLabel = user?.tz_label || null;
  const locale = user?.locale || null;
  const uid = user?.id || null;

  // TIER 1 — explicit id binding. In the demo, director_user == Slack id.
  // In prod, read a profile custom field or mapping table here instead.
  const boundFieldId =
    user?.profile?.fields && findFacilityProfileField(user.profile.fields);
  const explicitId = boundFieldId || uid;
  if (explicitId) {
    const hit = facilities.find((f) => f.director_user === explicitId);
    if (hit) {
      return {
        facility: hit,
        candidates: [hit],
        tier: "explicit",
        tz, tzLabel, locale,
        reason: `bound to ${hit.facility_name} via Slack id ${explicitId}`,
      };
    }
  }

  // TIER 2 — location inference from timezone.
  if (tz && TZ_TO_STATES[tz]) {
    const states = TZ_TO_STATES[tz];
    const candidates = facilities.filter((f) => states.includes(f.state));
    if (candidates.length === 1) {
      return {
        facility: candidates[0],
        candidates,
        tier: "location",
        tz, tzLabel, locale,
        reason: `single facility in tz ${tz} (${candidates[0].facility_name})`,
      };
    }
    if (candidates.length > 1) {
      return {
        facility: null, // ambiguous — caller briefs at region grain or asks
        candidates,
        tier: "location",
        tz, tzLabel, locale,
        reason: `${candidates.length} facilities in tz ${tz} (${states.join("/")}) — ambiguous, needs disambiguation or region-level brief`,
      };
    }
  }

  return {
    facility: null,
    candidates: [],
    tier: "none",
    tz, tzLabel, locale,
    reason: tz
      ? `no facility matched (tz ${tz}, no explicit binding)`
      : "no tz or explicit binding in Slack metadata",
  };
}

/**
 * Look for a facility binding in Slack profile custom fields. Returns the
 * bound value (facility_key or a Slack id) or null. Custom field IDs are
 * workspace-specific; we match on the human label to stay portable.
 */
function findFacilityProfileField(fields) {
  if (!fields || typeof fields !== "object") return null;
  for (const v of Object.values(fields)) {
    const label = (v?.label || v?.alt || "").toLowerCase();
    if (label.includes("facility") || label.includes("vha") || label.includes("va facility")) {
      return v?.value || null;
    }
  }
  return null;
}

/**
 * Live wrapper: fetch the Slack user via users.info and resolve. Heavy deps
 * are passed in (client, facilities) so this stays trivially testable.
 * @param {import("@slack/web-api").WebClient} client
 * @param {string} userId
 * @param {Array<object>} facilities
 */
async function fetchAndResolve(client, userId, facilities) {
  const res = await client.users.info({ user: userId });
  const user = res?.user;
  if (!user) {
    return {
      facility: null, candidates: [], tier: "none",
      tz: null, tzLabel: null, locale: null,
      reason: `users.info returned no user for ${userId}`,
    };
  }
  return resolveFromSlackUser(user, facilities);
}

module.exports = { resolveFromSlackUser, fetchAndResolve, TZ_TO_STATES };
