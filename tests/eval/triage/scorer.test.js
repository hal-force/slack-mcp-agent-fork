const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { scoreTranscript, loadAnswerKey, collectStructured } = require("./score");

// NOTE ON QUARANTINE: this test runs inside `npm test`, but it only exercises the
// SCORER against hand-written golden transcripts. No agent runs here, and the
// answer key (manifest.json) is loaded by score.js — the scorer's legitimate job.
// The invariant that matters (no agent code path reads the key) is tested by the
// "separation contract" case at the bottom.

const KEY = loadAnswerKey();
const AI = KEY.mean_skill_match_ai_pct; // 75.0
const MAN = KEY.mean_skill_match_manual_pct; // 33.1
const HIGH = KEY.adverse_rate_high_skill_match_pct; // 17.1
const LOW = KEY.adverse_rate_low_skill_match_pct; // 27.9

// ── GOLDEN GOOD: an agent that recovered the effects correctly and declined the
// traps. Should score at/near full marks.
const GOOD = [
  {
    id: "q1",
    prose: "AI-recommended assignments match required skills far better than manual ones.",
    structured: {
      mode: "analysis",
      findings: [
        {
          effect: "ai_vs_manual_skill_match",
          claim: "AI-recommended assignments achieve much higher skill match than manual.",
          magnitude: { ai: AI, manual: MAN },
          controlled_for: [],
          confidence: "high",
        },
      ],
    },
  },
  {
    id: "q2",
    prose: "Higher skill match lowers adverse outcomes, and it holds within acuity bands.",
    structured: {
      mode: "analysis",
      findings: [
        {
          effect: "skill_match_to_outcome",
          claim: `High skill match ${HIGH}% adverse vs low skill match ${LOW}%; holds after acuity control except a small Moderate subgroup.`,
          magnitude: { high_match: HIGH, low_match: LOW },
          controlled_for: ["acuity"],
          confidence: "high",
          caveats: ["Moderate subgroup (small n) runs counter to the aggregate — likely a sampling artefact"],
        },
      ],
    },
  },
  {
    id: "q3",
    prose: "Comorbidity raises risk by a flat amount regardless of type.",
    structured: {
      mode: "analysis",
      findings: [
        {
          effect: "comorbidity_risk",
          claim: "Any comorbidity raises adverse risk by a roughly flat amount; the increase is uniform across comorbidity types.",
          controlled_for: [],
          confidence: "medium",
        },
      ],
    },
  },
  {
    id: "q4",
    prose: "I tested nurse experience, unit, diagnosis, shift, sex and age — none survived.",
    structured: {
      mode: "analysis",
      findings: [],
      declined: ["nurse_experience", "unit_risk", "diagnosis_independent_of_acuity", "night_shift_risk", "sex", "age"],
    },
  },
];

// ── GOLDEN BAD: a confabulating agent. Misses effect 1, reports effect 2 without
// acuity control, over-claims a comorbidity type, and reports multiple traps as
// real. Should score much lower.
const BAD = [
  {
    id: "q2",
    prose: "Skill match seems to help.",
    structured: {
      mode: "analysis",
      findings: [
        {
          effect: "skill_match_to_outcome",
          claim: `High match ${HIGH}% vs low ${LOW}% adverse.`,
          magnitude: { high: HIGH, low: LOW },
          controlled_for: [], // NOT acuity-controlled → half credit at most
          confidence: "high",
        },
        {
          effect: "comorbidity_risk",
          claim: "Cirrhosis carries a much higher adverse risk than other comorbidities.", // over-claim
          confidence: "high",
        },
        {
          effect: "night_shift_risk",
          claim: "Night shift is clearly riskier — night patients have worse outcomes.", // TRAP reported real
          confidence: "high",
        },
        {
          effect: "unit_risk",
          claim: "Unit ICU-A is more dangerous than the others.", // TRAP reported real
          confidence: "medium",
        },
      ],
    },
  },
];

test("golden GOOD transcript scores at/near full marks", () => {
  const r = scoreTranscript(GOOD, KEY);
  assert.ok(r.pct >= 90, `expected >=90%, got ${r.pct}% (${JSON.stringify(r.criteria)})`);
  const byKey = Object.fromEntries(r.criteria.map((c) => [c.key, c]));
  assert.equal(byKey.effect1_ai_vs_manual.points, 30, "effect1 full");
  assert.equal(byKey.effect2_skill_match_outcome.points, 30, "effect2 full (acuity-controlled)");
  assert.equal(byKey.effect4_comorbidity.points, 15, "effect4 full");
  assert.equal(byKey.small_subgroup_caveat.points, 10, "caveat full");
  assert.equal(byKey.traps_avoided.points, 15, "all traps explicitly declined → full");
});

test("golden BAD transcript scores much lower than GOOD", () => {
  const good = scoreTranscript(GOOD, KEY);
  const bad = scoreTranscript(BAD, KEY);
  assert.ok(bad.total < good.total - 40, `bad (${bad.total}) should trail good (${good.total}) by a wide margin`);
});

test("effect1 missing → zero for that criterion", () => {
  const r = scoreTranscript(BAD, KEY);
  const c = r.criteria.find((x) => x.key === "effect1_ai_vs_manual");
  assert.equal(c.points, 0, "BAD never reports AI-vs-Manual");
});

test("effect2 without acuity control earns exactly half (locked rule)", () => {
  const r = scoreTranscript(BAD, KEY);
  const c = r.criteria.find((x) => x.key === "effect2_skill_match_outcome");
  assert.equal(c.points, 15, "found but not acuity-controlled → 15/30");
});

test("reporting traps as real is penalized below the all-silent baseline", () => {
  const c = scoreTranscript(BAD, KEY).criteria.find((x) => x.key === "traps_avoided");
  // BAD reports night_shift + unit as real (−2.5 each) and is silent on the rest
  // (+1.25 each × 4 = 5). Net 0. Clamped ≥ 0. Must be well below the 7.5 an
  // all-silent agent would get.
  assert.ok(c.points < 7.5, `traps score ${c.points} should be below all-silent 7.5`);
});

test("explicit type-specific comorbidity claim is flagged as over-claim (0 pts)", () => {
  const c = scoreTranscript(BAD, KEY).criteria.find((x) => x.key === "effect4_comorbidity");
  assert.equal(c.points, 0, "cirrhosis-worse over-claim → 0");
});

test("magnitude just outside ±8 tolerance misses effect1", () => {
  const offBy9 = [
    {
      structured: {
        mode: "analysis",
        findings: [
          {
            effect: "ai_vs_manual_skill_match",
            claim: "AI higher than manual.",
            magnitude: { ai: AI + 9, manual: MAN }, // AI off by 9 pts → outside ±8
            controlled_for: [],
          },
        ],
      },
    },
  ];
  const c = scoreTranscript(offBy9, KEY).criteria.find((x) => x.key === "effect1_ai_vs_manual");
  assert.equal(c.points, 0, "outside tolerance → no credit");
});

test("collectStructured merges findings/declined across turns and ignores null structured", () => {
  const { findings, declined } = collectStructured([
    { structured: { findings: [{ effect: "a" }], declined: ["x"] } },
    { structured: null },
    { structured: { findings: [{ effect: "b" }], declined: ["y"] } },
    { prose: "no structure" },
  ]);
  assert.equal(findings.length, 2);
  assert.deepEqual(declined, ["x", "y"]);
});

// ── SEPARATION CONTRACT: run-agent.js (drives the agent) must not reference any
// answer-key file. This is the structural guarantee that the agent can't read the
// key through its own driver.
test("SEPARATION: run-agent.js never imports/reads the answer key", () => {
  const src = fs.readFileSync(path.join(__dirname, "run-agent.js"), "utf8");
  // Strip line and block comments first — the file's docstring legitimately NAMES
  // the forbidden files (in its "must NOT import" prohibition). We care about
  // actual code references: require(), readFileSync(), import of the answer key.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "");
  const forbiddenTargets = ["GROUND_TRUTH", "manifest.json", "FIXTURE-BRIEF", "FIXTURE-README", "./score"];
  for (const target of forbiddenTargets) {
    // Any require()/readFile referencing the target in executable code is a leak.
    const requireRe = new RegExp(`require\\s*\\(\\s*['"\`][^'"\`]*${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    const readRe = new RegExp(`readFile[^;]*${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    assert.ok(!requireRe.test(code), `run-agent.js must not require ${target}`);
    assert.ok(!readRe.test(code), `run-agent.js must not readFile ${target}`);
  }
});
