const { test } = require("node:test");
const assert = require("node:assert/strict");

const { SCRM_SYSTEM_PROMPT } = require("../../src/agents/scrmSpecialist");

// The eval (tests/eval/scrm) only measures discovery if the prompt gives none of the
// answer key away: no magnitudes, no named controls, no trap list, no expected caveat.
test("system prompt carries methodology but NOT the answer key", () => {
  const p = SCRM_SYSTEM_PROMPT;
  assert.match(p, /control for confounders/i);
  assert.match(p, /interaction/i);
  assert.match(p, /fan out/i);
  assert.match(p, /composite_risk_pct/); // named as unavailable (the column is absent)

  assert.doesNotMatch(p, /70\.1|30\.8|66\.4|15\.8|67\.6|31\.7|38\.9|29\.7|0\.76/, "no realized magnitudes");
  assert.doesNotMatch(p, /planted|ground.?truth/i, "no reference to the answer key");
  assert.doesNotMatch(p, /\bn\s*[=<]\s*\d/, "no expected thin-cell caveat");
  assert.doesNotMatch(p, /trajectory|confounded by[^.]*archetype/i, "no named confound for the financial link");
  assert.doesNotMatch(p, /foci_to_cyber|ssconc_to_delivery|financial_to_delivery/, "no enumerated effect keys");
  // sector / criticality / the trap attributes may appear ONLY in the data dictionary line.
  for (const term of ["sector", "criticality", "small_business", "established_year", "contract_count"]) {
    const hits = p.match(new RegExp(term, "gi")) || [];
    assert.equal(hits.length, 1, `"${term}" appears only in the data dictionary (found ${hits.length})`);
  }
});
