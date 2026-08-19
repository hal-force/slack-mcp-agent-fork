/**
 * Resolve a Slack user to their POSITION — the metric owning_function(s) their
 * brief should cover. This is the "position" half of the localized brief;
 * resolveUserFacility.js is the "location" half. Together they parameterize
 * the agent's response: WHICH facility (location) × WHICH metrics (position).
 *
 * WHY POSITION MATTERS
 *   A facility's off-target metrics span several roles. The Quality Manager
 *   owns SMR30 + OMELOS; the Care Transitions Lead owns READMIT30 + PHA
 *   referral; the Access Manager owns RVU capacity; the Patient Experience
 *   Officer owns SHEP. Handing every administrator the whole facility dump is
 *   exactly the "corporate metric dump" this demo exists to replace. So the
 *   brief is filtered to the metrics whose owning_function matches the user's
 *   position — off-target metrics they can actually act on.
 *
 *   A facility DIRECTOR is the exception: they own the whole facility, so their
 *   position resolves to ALL functions (a facility-wide brief).
 *
 * WHERE POSITION COMES FROM (Slack metadata, tiered, most-authoritative first)
 *   TIER 1 — explicit binding. A profile custom field ("VHA Function"/"Role")
 *     whose value names an owning_function. Portable label match, like the
 *     facility field. In prod this is the authoritative source.
 *   TIER 1b — director id. If the Slack id is a facility's director_user, the
 *     position is ALL functions (facility-wide). Lets the current demo, which
 *     targets directors, still produce a full-facility brief.
 *   TIER 2 — job title inference. users.info returns profile.title
 *     ("Quality Manager", "Chief of Access", "Medical Center Director"). We
 *     token-match it against the known function names (and director synonyms).
 *   TIER 3 — none. Caller decides: default to facility-wide, or skip.
 *
 * SECURITY / TRUST
 *   Slack profile text is semi-trusted identity, used ONLY to pick which
 *   functions to include. It is never treated as an instruction. (Untrusted
 *   action-plan free text is fenced downstream in getAiResponse, unchanged.)
 *
 * PURE + TESTABLE
 *   resolveFunctionsFromSlackUser() takes a plain users.info user object plus
 *   the registry + facilities rows, so it unit-tests without credentials.
 */

// Special sentinel: this user owns every function (facility-wide brief).
const ALL_FUNCTIONS = "ALL";

// Token cues that map a free-text job title to an owning_function. Kept
// data-light: we intersect title tokens with these cues, then confirm the
// resulting function actually exists in the registry. Director synonyms
// short-circuit to ALL_FUNCTIONS.
const DIRECTOR_CUES = ["director", "medical center director", "chief of staff", "executive"];
const FUNCTION_CUES = [
  { fn: "Quality Manager", cues: ["quality", "safety", "mortality"] },
  { fn: "Care Transitions Lead", cues: ["transition", "care coordination", "readmission", "discharge"] },
  { fn: "Access Manager", cues: ["access", "capacity", "scheduling", "rvu"] },
  { fn: "Patient Experience Officer", cues: ["experience", "patient experience", "shep", "veteran experience"] },
];

/** Distinct owning_function values actually present in the registry. */
function knownFunctions(registry) {
  return [...new Set((registry || []).map((m) => m.owning_function).filter(Boolean))];
}

/**
 * @param {object} user  a Slack users.info user object (or its subset)
 * @param {{registry: object[], facilities: object[]}} dims
 * @returns {{
 *   functions: string[] | "ALL",  // owning_functions to include (ALL = facility-wide)
 *   isDirector: boolean,
 *   tier: "explicit" | "director" | "title" | "none",
 *   title: string|null,
 *   reason: string
 * }}
 */
function resolveFunctionsFromSlackUser(user, { registry, facilities }) {
  const known = knownFunctions(registry);
  const uid = user?.id || null;
  const title = user?.profile?.title || null;

  // TIER 1 — explicit binding via a profile custom field naming a function.
  const boundFn = user?.profile?.fields && findFunctionProfileField(user.profile.fields, known);
  if (boundFn) {
    return {
      functions: [boundFn], isDirector: false, tier: "explicit", title,
      reason: `bound to "${boundFn}" via Slack profile field`,
    };
  }

  // TIER 1b — director id → facility-wide (ALL functions).
  if (uid && (facilities || []).some((f) => f.director_user === uid)) {
    return {
      functions: ALL_FUNCTIONS, isDirector: true, tier: "director", title,
      reason: `Slack id ${uid} is a facility director — facility-wide brief`,
    };
  }

  // TIER 2 — infer from job title.
  if (title) {
    const t = title.toLowerCase();
    if (DIRECTOR_CUES.some((c) => t.includes(c))) {
      return {
        functions: ALL_FUNCTIONS, isDirector: true, tier: "title", title,
        reason: `title "${title}" reads as facility leadership — facility-wide brief`,
      };
    }
    const matched = FUNCTION_CUES
      .filter((entry) => known.includes(entry.fn) && entry.cues.some((c) => t.includes(c)))
      .map((entry) => entry.fn);
    if (matched.length) {
      return {
        functions: [...new Set(matched)], isDirector: false, tier: "title", title,
        reason: `title "${title}" matched function(s): ${matched.join(", ")}`,
      };
    }
  }

  // TIER 3 — nothing to go on.
  return {
    functions: [], isDirector: false, tier: "none", title,
    reason: title ? `title "${title}" matched no known function` : "no function binding or title in Slack metadata",
  };
}

/** Match a profile custom field naming a function; returns the canonical function or null. */
function findFunctionProfileField(fields, known) {
  if (!fields || typeof fields !== "object") return null;
  for (const v of Object.values(fields)) {
    const label = (v?.label || v?.alt || "").toLowerCase();
    if (label.includes("function") || label.includes("role") || label.includes("position")) {
      const val = (v?.value || "").trim();
      // exact (case-insensitive) match to a known function wins
      const exact = known.find((fn) => fn.toLowerCase() === val.toLowerCase());
      if (exact) return exact;
      // otherwise a contains-match (e.g. "Quality Manager, VISN 18")
      const partial = known.find((fn) => val.toLowerCase().includes(fn.toLowerCase()));
      if (partial) return partial;
    }
  }
  return null;
}

/**
 * Does a resolved position include a given metric's owning_function?
 * ALL_FUNCTIONS (director) includes everything.
 */
function positionCoversFunction(functions, owningFunction) {
  if (functions === ALL_FUNCTIONS) return true;
  return Array.isArray(functions) && functions.includes(owningFunction);
}

/** Live wrapper: fetch the user then resolve. Deps passed in for testability. */
async function fetchAndResolvePosition(client, userId, dims) {
  const res = await client.users.info({ user: userId });
  const user = res?.user;
  if (!user) {
    return { functions: [], isDirector: false, tier: "none", title: null,
      reason: `users.info returned no user for ${userId}` };
  }
  return resolveFunctionsFromSlackUser(user, dims);
}

module.exports = {
  ALL_FUNCTIONS,
  resolveFunctionsFromSlackUser,
  positionCoversFunction,
  fetchAndResolvePosition,
  knownFunctions,
};
