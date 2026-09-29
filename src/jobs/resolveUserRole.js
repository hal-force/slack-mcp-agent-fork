/**
 * Resolve a Slack user to their ROLE — the KRI owning_function(s) their SCRM
 * risk brief should cover. This is the "role" half of the localized SCRM brief;
 * resolveUserPortfolio.js is the "portfolio" half. Together they parameterize
 * the brief: WHICH portfolio(s) (portfolio) × WHICH KRIs (role).
 *
 * This is the SCRM analog of resolveUserPosition.js (VHA POSITION). The shape,
 * tiers, and trust model are identical; only the vocabulary changes:
 *   VHA owning_function (Quality Manager, Access Manager, …)  →
 *   SCRM owning_function (Cyber SCRM Analyst, Logistics Analyst, …), read from
 *   the SCRM risk registry (one owning_function per KRI).
 *
 * WHY ROLE MATTERS
 *   A program office's flagged supplier×KRI risks span several analyst desks.
 *   The Cyber SCRM Analyst owns CYBER; the Logistics Analyst owns DELIVERY; the
 *   Compliance Analyst owns PROHIBITED_SRC. Handing every analyst the whole
 *   portfolio's alert dump is the "risk dump" this demo replaces. So the brief
 *   is filtered to the KRIs whose owning_function matches the user's role.
 *
 *   A program DIRECTOR / CISO is the exception: they own the whole program, so
 *   their role resolves to ALL functions (a program-wide brief).
 *
 * WHERE ROLE COMES FROM (Slack metadata, tiered, most-authoritative first)
 *   TIER 1  — explicit binding. A profile custom field ("SCRM Role"/"Function")
 *     whose value names an owning_function, or the sentinel "director"/"CISO"/
 *     "ALL" for a program-wide brief. In prod this is the authoritative source
 *     (and is what SCRM_BRIEF_BINDINGS injects).
 *   TIER 2  — job-title inference. users.info returns profile.title
 *     ("Cyber SCRM Analyst", "SCRM Director"). Token-match it against the known
 *     function names (and director synonyms).
 *   TIER 3  — none. Caller decides: default to program-wide, or skip.
 *
 * SECURITY / TRUST
 *   Slack profile text is semi-trusted identity, used ONLY to pick which KRIs to
 *   include — never as an instruction. (Untrusted finding free text is fenced
 *   downstream in the specialist's skillContext, unchanged.)
 *
 * PURE + TESTABLE
 *   resolveRoleFromSlackUser() takes a plain users.info user object plus the
 *   registry rows, so it unit-tests without credentials.
 */

// Special sentinel: this user owns every KRI (program-wide brief).
const ALL_FUNCTIONS = "ALL";

// Values (in an explicit binding field or a title) that mean "program-wide".
const DIRECTOR_CUES = [
  "director",
  "ciso",
  "chief information security",
  "program manager",
  "program office",
  "risk executive",
  "head of supply chain",
  "deputy director",
  "chief",
];

// Token cues that map a free-text job title to a KRI owning_function. Kept
// data-light: we intersect title tokens with these cues, then confirm the
// resulting function actually exists in the registry. Director synonyms
// short-circuit to ALL_FUNCTIONS.
const FUNCTION_CUES = [
  { fn: "Foreign Influence Analyst", cues: ["foci", "foreign influence", "foreign ownership", "foreign"] },
  { fn: "Compliance Analyst", cues: ["compliance", "prohibited", "889", "ofac", "sanction", "sam.gov", "debarment"] },
  { fn: "Cyber SCRM Analyst", cues: ["cyber", "cmmc", "security posture", "infosec", "800-171"] },
  { fn: "Acquisition Analyst", cues: ["acquisition", "financial", "procurement", "contracting"] },
  { fn: "Logistics Analyst", cues: ["logistics", "delivery", "schedule", "sustainment"] },
  { fn: "Portfolio Manager", cues: ["portfolio", "concentration", "single-source", "single source", "supplier diversity"] },
  { fn: "Product Assurance Analyst", cues: ["product assurance", "authenticity", "counterfeit", "provenance", "quality", "sbom"] },
];

/** Distinct owning_function values actually present in the registry. */
function knownFunctions(registry) {
  return [...new Set((registry || []).map((m) => m.owning_function).filter(Boolean))];
}

/** Map KRI (risk_category) → owning_function, from the registry. */
function owningFunctionByCategory(registry) {
  const m = new Map();
  for (const r of registry || []) {
    if (r.risk_category) m.set(r.risk_category, r.owning_function);
  }
  return m;
}

/** Is a binding/title value one of the program-wide (director) sentinels? */
function readsAsDirector(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return false;
  if (v === "all" || v === "program" || v === "program office" || v === "program-wide") return true;
  return DIRECTOR_CUES.some((c) => v.includes(c));
}

/**
 * @param {object} user  a Slack users.info user object (or its subset)
 * @param {{registry: object[]}} dims
 * @returns {{
 *   functions: string[] | "ALL",  // owning_functions to include (ALL = program-wide)
 *   isDirector: boolean,
 *   tier: "explicit" | "title" | "none",
 *   title: string|null,
 *   reason: string
 * }}
 */
function resolveRoleFromSlackUser(user, { registry }) {
  const known = knownFunctions(registry);
  const title = user?.profile?.title || null;

  // TIER 1 — explicit binding via a profile custom field naming a role.
  const bound = user?.profile?.fields && findRoleProfileField(user.profile.fields, known);
  if (bound) {
    if (bound === ALL_FUNCTIONS) {
      return { functions: ALL_FUNCTIONS, isDirector: true, tier: "explicit", title,
        reason: "bound to program-wide (director/CISO) via Slack profile field" };
    }
    return { functions: [bound], isDirector: false, tier: "explicit", title,
      reason: `bound to "${bound}" via Slack profile field` };
  }

  // TIER 2 — infer from job title.
  if (title) {
    if (readsAsDirector(title)) {
      return { functions: ALL_FUNCTIONS, isDirector: true, tier: "title", title,
        reason: `title "${title}" reads as program leadership — program-wide brief` };
    }
    const t = title.toLowerCase();
    const matched = FUNCTION_CUES
      .filter((entry) => known.includes(entry.fn) && entry.cues.some((c) => t.includes(c)))
      .map((entry) => entry.fn);
    if (matched.length) {
      return { functions: [...new Set(matched)], isDirector: false, tier: "title", title,
        reason: `title "${title}" matched function(s): ${matched.join(", ")}` };
    }
  }

  // TIER 3 — nothing to go on.
  return { functions: [], isDirector: false, tier: "none", title,
    reason: title ? `title "${title}" matched no known function` : "no role binding or title in Slack metadata" };
}

/**
 * Match a profile custom field naming a role; returns the canonical function,
 * the ALL_FUNCTIONS sentinel (for a director/program binding), or null.
 */
function findRoleProfileField(fields, known) {
  if (!fields || typeof fields !== "object") return null;
  for (const v of Object.values(fields)) {
    const label = (v?.label || v?.alt || "").toLowerCase();
    if (label.includes("role") || label.includes("function") || label.includes("position") || label.includes("scrm role")) {
      const val = (v?.value || "").trim();
      if (!val) continue;
      if (readsAsDirector(val)) return ALL_FUNCTIONS;
      // exact (case-insensitive) match to a known function wins
      const exact = known.find((fn) => fn.toLowerCase() === val.toLowerCase());
      if (exact) return exact;
      // otherwise a contains-match (e.g. "Cyber SCRM Analyst, ICT Hardware")
      const partial = known.find((fn) => val.toLowerCase().includes(fn.toLowerCase()));
      if (partial) return partial;
    }
  }
  return null;
}

/**
 * Does a resolved role include a given KRI's owning_function?
 * ALL_FUNCTIONS (director) includes everything.
 */
function roleCoversFunction(functions, owningFunction) {
  if (functions === ALL_FUNCTIONS) return true;
  return Array.isArray(functions) && functions.includes(owningFunction);
}

module.exports = {
  ALL_FUNCTIONS,
  resolveRoleFromSlackUser,
  roleCoversFunction,
  knownFunctions,
  owningFunctionByCategory,
  readsAsDirector,
};
