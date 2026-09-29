const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { scoreTranscript, loadAnswerKey, collectStructured } = require("./score");

// NOTE ON QUARANTINE: this test runs inside `npm test`, but it only exercises the SCORER
// against hand-written golden transcripts. No agent runs here, and the answer key
// (manifest.json) is loaded by score.js — the scorer's legitimate job. The invariant that
// matters (no agent code path reads the key) is tested by the "separation contract" case
// at the bottom.

const KEY = loadAnswerKey();
const E1 = KEY.effect1_foci_cyber_prohibited; // cyber 70.1/30.8, prohibited 66.4/15.8
const E2 = KEY.effect2_ssconc_delivery_interaction; // mc 67.6/31.7, nonmc 38.9/29.7
const E3 = KEY.effect3_financial_delivery; // r 0.76

// ── GOLDEN GOOD: an agent that recovered all three effects (with the sector + criticality
// controls and the confound note) and declined every trap. Should score at/near full.
const GOOD = [
  {
    id: "q1_foci_cyber",
    prose: "FOCI suppliers carry far higher cyber and prohibited-source risk, and it holds within every shared sector.",
    structured: {
      mode: "analysis",
      findings: [
        {
          effect: "foci_to_cyber_prohibited",
          claim: "FOCI-flagged suppliers score much higher on cyber and prohibited-source risk than other suppliers.",
          magnitude: { cyber_foci: E1.cyber_foci, cyber_non_foci: E1.cyber_non_foci, prohibited_foci: E1.prohibited_foci, prohibited_non_foci: E1.prohibited_non_foci },
          controlled_for: ["sector"],
          confidence: "high",
          caveats: ["Confirmed the gap holds within each shared sector."],
        },
      ],
    },
  },
  {
    id: "q2_concentration_delivery",
    prose: "Single-source geographic concentration raises delivery risk, but only for Mission-Critical suppliers.",
    structured: {
      mode: "analysis",
      findings: [
        {
          effect: "ssconc_to_delivery",
          claim: "Single-source concentrated supply raises delivery risk, but only for Mission-Critical suppliers (an interaction with criticality).",
          magnitude: { mc_ssconc: E2.delivery_mc_ssconc, mc_not: E2.delivery_mc_not, nonmc_ssconc: E2.delivery_nonmc_ssconc, nonmc_not: E2.delivery_nonmc_not },
          controlled_for: ["criticality"],
          confidence: "high",
          caveats: ["The non-concentrated Mission-Critical cell is thin (n=2) — treat 31.7 cautiously."],
        },
      ],
    },
  },
  {
    id: "q3_financial_delivery",
    prose: "Financial distress correlates with delivery risk, but the link is confounded.",
    structured: {
      mode: "analysis",
      findings: [
        {
          effect: "financial_to_delivery",
          claim: "Financial-distress and delivery risk show a strong positive correlation, but it is confounded by supplier trajectory — not clean causation.",
          magnitude: { r: E3.r_financial_delivery },
          controlled_for: [],
          confidence: "medium",
        },
      ],
    },
  },
  {
    id: "q4_rule_outs",
    prose: "I tested business size, how long the supplier has been established, contract count and the precomputed composite — none is a real driver.",
    structured: {
      mode: "analysis",
      findings: [],
      declined: ["small_business", "established_year", "contract_count", "composite_risk_pct"],
    },
  },
];

// ── GOLDEN BAD: a confabulating agent. Misses E1, reports E2 without the criticality
// interaction, over-claims E3 causation, and reports two traps as real. Should score much
// lower.
const BAD = [
  {
    id: "q2_concentration_delivery",
    prose: "A few relationships jump out.",
    structured: {
      mode: "analysis",
      findings: [
        {
          effect: "ssconc_to_delivery",
          claim: "Single-source concentration raises delivery risk across the portfolio.",
          magnitude: { ssconc: 50 },
          controlled_for: [], // no criticality interaction → partial
          confidence: "high",
        },
        {
          effect: "financial_to_delivery",
          claim: "Financial distress causes delivery failures.", // over-claims causation
          magnitude: { r: 0.8 },
          confidence: "high",
        },
        {
          effect: "small_business_risk",
          claim: "Small-business suppliers are clearly riskier than large ones.", // TRAP reported real
          confidence: "high",
        },
        {
          effect: "contract_count_risk",
          claim: "Suppliers with more contracts carry higher risk.", // TRAP reported real
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
  assert.equal(byKey.effect1_foci_cyber_prohibited.points, 30, "E1 full (gap + sector)");
  assert.equal(byKey.effect2_ssconc_delivery_interaction.points, 25, "E2 full (link + criticality interaction)");
  assert.equal(byKey.effect3_financial_delivery.points, 15, "E3 full (association, no over-claim)");
  assert.equal(byKey.traps_avoided.points, 20, "all traps explicitly declined → full");
  assert.equal(byKey.thin_subgroup_caveat.points, 10, "thin-cell caveat present");
});

test("golden BAD transcript scores much lower than GOOD", () => {
  const good = scoreTranscript(GOOD, KEY);
  const bad = scoreTranscript(BAD, KEY);
  assert.ok(bad.total < good.total - 40, `bad (${bad.total}) should trail good (${good.total}) by a wide margin`);
});

test("E1 missing → zero for that criterion", () => {
  const c = scoreTranscript(BAD, KEY).criteria.find((x) => x.key === "effect1_foci_cyber_prohibited");
  assert.equal(c.points, 0, "BAD never reports the FOCI cross-KRI link");
});

test("E2 without the criticality interaction earns partial (locked rule)", () => {
  const c = scoreTranscript(BAD, KEY).criteria.find((x) => x.key === "effect2_ssconc_delivery_interaction");
  assert.equal(c.points, 12, "link found but interaction missed → 12/25");
});

test("E2 interaction reported as a SIBLING finding earns full marks", () => {
  // Command A Plus sometimes emits the link and its interaction as two findings
  // rather than one enriched finding. The scorer must credit the interaction
  // wherever it lands.
  const split = [
    {
      structured: {
        mode: "analysis",
        findings: [
          {
            effect: "ssconc_to_delivery",
            claim: "Geographically concentrated suppliers have significantly higher delivery risk.",
            magnitude: { mc_ssconc: E2.delivery_mc_ssconc, mc_not: E2.delivery_mc_not },
            controlled_for: ["sector"],
          },
          {
            effect: "criticality_interaction",
            claim: "The concentration-delivery risk relationship is amplified for mission-critical suppliers.",
            controlled_for: ["criticality"],
            caveats: ["Mission-critical concentrated subgroup n=5"],
          },
        ],
      },
    },
  ];
  const c = scoreTranscript(split, KEY).criteria.find((x) => x.key === "effect2_ssconc_delivery_interaction");
  assert.equal(c.points, 25, "link + sibling interaction finding → full 25");
});

test("a criticality MAIN-effect sibling (no concentration framing) does NOT fake the interaction", () => {
  // A finding that merely says "Mission-Critical suppliers have higher delivery
  // risk" is a main effect, not the concentration×criticality interaction.
  const mainEffectOnly = [
    {
      structured: {
        mode: "analysis",
        findings: [
          {
            effect: "ssconc_to_delivery",
            claim: "Concentrated suppliers have higher delivery risk.",
            magnitude: { mc_ssconc: E2.delivery_mc_ssconc },
            controlled_for: [],
          },
          { effect: "criticality_to_delivery", claim: "Mission-Critical suppliers carry higher delivery risk overall.", controlled_for: [] },
        ],
      },
    },
  ];
  const c = scoreTranscript(mainEffectOnly, KEY).criteria.find((x) => x.key === "effect2_ssconc_delivery_interaction");
  assert.equal(c.points, 12, "main effect without the interaction framing → partial only");
});

test("E3 over-claiming causation earns exactly half", () => {
  const c = scoreTranscript(BAD, KEY).criteria.find((x) => x.key === "effect3_financial_delivery");
  assert.equal(c.points, 7.5, "financial CAUSES delivery → half credit");
});

test("reporting traps as real is penalized below the all-silent baseline", () => {
  const c = scoreTranscript(BAD, KEY).criteria.find((x) => x.key === "traps_avoided");
  // BAD reports small_business + contract_count as real (−5 each) and is silent on the
  // other two (+2.5 each = 5). Net −5 → clamped 0. Well below the 10 an all-silent agent
  // would score.
  assert.ok(c.points < 10, `traps score ${c.points} should be below all-silent 10`);
});

test("traps reported as NULL findings (natural phrasing) count as declines", () => {
  // Command A Plus reported the nulls as findings with keys like
  // "small_business_to_overall_risk" and prose "shows no consistent relationship"
  // / "no meaningful correlation" — a correct null result, not a false positive.
  const nullFindings = [
    {
      structured: {
        mode: "analysis",
        findings: [
          { effect: "small_business_to_overall_risk", claim: "Small business status shows no consistent relationship with overall risk after sector control." },
          { effect: "established_year_to_overall_risk", claim: "Supplier age shows no meaningful correlation with overall risk." },
          { effect: "contract_count_note", claim: "The number of contracts has no bearing on risk once tested." },
          { effect: "composite_note", claim: "The precomputed composite score is a circular roll-up; it shows no independent signal and was not used." },
        ],
      },
    },
  ];
  const c = scoreTranscript(nullFindings, KEY).criteria.find((x) => x.key === "traps_avoided");
  assert.equal(c.points, 20, "four correctly-reported nulls → full trap credit");
});

test("an explicit declined[] entry wins over a same-named positive-sounding finding", () => {
  const declinedWins = [
    {
      structured: {
        mode: "analysis",
        findings: [{ effect: "small_business", claim: "Small businesses appear riskier at first glance." }],
        declined: ["small_business"],
      },
    },
  ];
  const c = scoreTranscript(declinedWins, KEY).criteria.find((x) => x.key === "traps_avoided");
  // small_business declined (+5); the other three traps silent (+2.5 each = 7.5) → 12.5.
  // Without decline-precedence the finding would have scored it −5 (→ 2.5 total).
  assert.equal(c.points, 12.5, "declared decline is authoritative");
});

test("E1 magnitude just outside ±8 tolerance misses the effect", () => {
  const offBy9 = [
    {
      structured: {
        mode: "analysis",
        findings: [
          {
            effect: "foci_to_cyber_prohibited",
            claim: "FOCI suppliers score higher on cyber than others.",
            magnitude: { cyber_foci: E1.cyber_foci + 9, cyber_non_foci: E1.cyber_non_foci }, // off by 9
            controlled_for: ["sector"],
          },
        ],
      },
    },
  ];
  const c = scoreTranscript(offBy9, KEY).criteria.find((x) => x.key === "effect1_foci_cyber_prohibited");
  assert.equal(c.points, 0, "outside tolerance → no credit");
});

test("E1 without a sector control earns 20 (gap only)", () => {
  const noSector = [
    {
      structured: {
        mode: "analysis",
        findings: [
          {
            effect: "foci_to_cyber_prohibited",
            claim: "FOCI suppliers score higher on cyber and prohibited-source risk.",
            magnitude: { cyber_foci: E1.cyber_foci, cyber_non_foci: E1.cyber_non_foci },
            controlled_for: [],
          },
        ],
      },
    },
  ];
  const c = scoreTranscript(noSector, KEY).criteria.find((x) => x.key === "effect1_foci_cyber_prohibited");
  assert.equal(c.points, 20, "gap + direction without sector confirmation → 20/30");
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

// ── SEPARATION CONTRACT: run-agent.js (drives the agent) must not reference any answer-key
// file. This is the structural guarantee that the agent can't read the key through its
// own driver.
test("SEPARATION: run-agent.js never imports/reads the answer key", () => {
  const src = fs.readFileSync(path.join(__dirname, "run-agent.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
  const forbiddenTargets = ["GROUND_TRUTH", "manifest.json", "FIXTURE-BRIEF", "FIXTURE-README", "./score"];
  for (const target of forbiddenTargets) {
    const requireRe = new RegExp(`require\\s*\\(\\s*['"\`][^'"\`]*${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    const readRe = new RegExp(`readFile[^;]*${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    assert.ok(!requireRe.test(code), `run-agent.js must not require ${target}`);
    assert.ok(!readRe.test(code), `run-agent.js must not readFile ${target}`);
  }
});
