/**
 * Resolve a Slack user to the supplier PORTFOLIO(s) their SCRM risk brief should
 * cover — the "portfolio" half of the localized SCRM brief (resolveUserRole.js
 * is the "role" half). Together they parameterize the brief: WHICH portfolio(s)
 * (portfolio) × WHICH KRIs (role).
 *
 * This is the SCRM analog of resolveUserFacility.js (VHA LOCATION). A VA facility
 * is a physical place resolvable from a Slack timezone; a SCRM portfolio is an
 * organizational lane (ICT Hardware, Cloud & Software, …) with a named owner, so
 * there is no timezone tier — portfolio comes from an explicit binding or from
 * the user being a portfolio's owner. A program DIRECTOR / CISO spans the whole
 * program, so their portfolio resolves to ALL_PORTFOLIOS (every lane).
 *
 * WHERE PORTFOLIO COMES FROM (Slack metadata, tiered, most-authoritative first)
 *   TIER 1  — explicit binding. A profile custom field ("SCRM Portfolio") whose
 *     value names a portfolio, an owner id, or the sentinel "ALL"/"program" for
 *     a program-wide brief. This is what SCRM_BRIEF_BINDINGS injects.
 *   TIER 1b — owner id. If the Slack id is a portfolio's portfolio_owner_user,
 *     that portfolio is theirs.
 *   TIER 2  — none. Caller decides: default to program-wide, or skip.
 *
 * SECURITY / TRUST
 *   Slack metadata is semi-trusted identity, read ONLY to pick a portfolio; it
 *   is never treated as an instruction.
 *
 * PURE + TESTABLE
 *   resolvePortfolioFromSlackUser() takes a plain users.info user object + the
 *   portfolios dimension (derived from the suppliers table), so it unit-tests
 *   without credentials.
 */

// Special sentinel: this user owns every portfolio (program-wide brief).
const ALL_PORTFOLIOS = "ALL";

/** Values (in a binding field) that mean "the whole program". */
function readsAsAllPortfolios(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "all" || v === "program" || v === "program office" || v === "all portfolios" || v === "program-wide";
}

/**
 * Build the portfolios dimension from the suppliers table: one entry per
 * distinct portfolio, carrying its owner id + name (the "director_user" analog).
 * @param {object[]} suppliers
 * @returns {{portfolio_name:string, owner_user:string, owner_name:string, supplier_count:number}[]}
 */
function portfoliosFromSuppliers(suppliers) {
  const byName = new Map();
  for (const s of suppliers || []) {
    const name = s.portfolio;
    if (!name) continue;
    if (!byName.has(name)) {
      byName.set(name, {
        portfolio_name: name,
        owner_user: s.portfolio_owner_user || null,
        owner_name: s.portfolio_owner_name || null,
        supplier_count: 0,
      });
    }
    byName.get(name).supplier_count += 1;
  }
  return [...byName.values()].sort((a, b) => a.portfolio_name.localeCompare(b.portfolio_name));
}

/**
 * @param {object} user  a Slack users.info user object (or its subset)
 * @param {Array<object>} portfolios  from portfoliosFromSuppliers()
 * @returns {{
 *   portfolios: "ALL" | string[],   // portfolio names to include (ALL = program-wide)
 *   primary: object|null,           // the single portfolio they own (for the header), or null when ALL
 *   tier: "explicit"|"owner"|"none",
 *   reason: string
 * }}
 */
function resolvePortfolioFromSlackUser(user, portfolios) {
  const uid = user?.id || null;
  const all = (portfolios || []).map((p) => p.portfolio_name);

  // TIER 1 — explicit binding via a profile custom field.
  const boundVal = user?.profile?.fields && findPortfolioProfileField(user.profile.fields);
  if (boundVal) {
    if (readsAsAllPortfolios(boundVal)) {
      return { portfolios: ALL_PORTFOLIOS, primary: null, tier: "explicit",
        reason: "bound to program-wide (all portfolios) via Slack profile field" };
    }
    // Match the bound value to a portfolio by name (exact/contains) or owner id.
    const v = boundVal.trim().toLowerCase();
    const hit =
      (portfolios || []).find((p) => p.portfolio_name.toLowerCase() === v) ||
      (portfolios || []).find((p) => p.owner_user && p.owner_user.toLowerCase() === v) ||
      (portfolios || []).find((p) => p.portfolio_name.toLowerCase().includes(v));
    if (hit) {
      return { portfolios: [hit.portfolio_name], primary: hit, tier: "explicit",
        reason: `bound to portfolio "${hit.portfolio_name}" via Slack profile field` };
    }
  }

  // TIER 1b — the user IS a portfolio owner.
  if (uid) {
    const owned = (portfolios || []).find((p) => p.owner_user === uid);
    if (owned) {
      return { portfolios: [owned.portfolio_name], primary: owned, tier: "owner",
        reason: `Slack id ${uid} owns portfolio "${owned.portfolio_name}"` };
    }
  }

  // TIER 2 — nothing to go on.
  return { portfolios: [], primary: null, tier: "none",
    reason: all.length ? "no portfolio binding or ownership in Slack metadata" : "no portfolios in data" };
}

/**
 * Look for a portfolio binding in Slack profile custom fields. Returns the bound
 * value (a portfolio name, owner id, or "ALL") or null. Custom field ids are
 * workspace-specific; we match on the human label to stay portable.
 */
function findPortfolioProfileField(fields) {
  if (!fields || typeof fields !== "object") return null;
  for (const v of Object.values(fields)) {
    const label = (v?.label || v?.alt || "").toLowerCase();
    if (label.includes("portfolio") || label.includes("scrm portfolio")) {
      return v?.value || null;
    }
  }
  return null;
}

/** Does a resolved portfolio scope include a given row's portfolio? ALL includes everything. */
function portfolioCovers(portfolioScope, portfolioName) {
  if (portfolioScope === ALL_PORTFOLIOS) return true;
  return Array.isArray(portfolioScope) && portfolioScope.includes(portfolioName);
}

module.exports = {
  ALL_PORTFOLIOS,
  portfoliosFromSuppliers,
  resolvePortfolioFromSlackUser,
  portfolioCovers,
  findPortfolioProfileField,
  readsAsAllPortfolios,
};
