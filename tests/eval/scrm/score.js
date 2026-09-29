/**
 * score.js — grades an SCRM-specialist transcript against the answer key.
 *
 * ── Separation contract ──────────────────────────────────────────────────
 * This file lives in the QUARANTINE (tests/eval/scrm) and is the ONLY code permitted to
 * read the answer key (manifest.json / GROUND_TRUTH.md). It is a SCORER, never part of
 * any agent path. run-agent.js (which drives the agent) must never require this module
 * or the answer key. See README.md / the fixture design.
 *
 * ── What it grades ─────────────────────────────────────────────────────────
 * Input: a transcript = an array of per-question results, each { structured } as emitted
 * by the specialist (defineAgent parses the trailing ```json block into `structured`).
 * The scorer merges findings/declined across all questions (the agent may surface an
 * effect under any question) and grades the merged view.
 *
 * Rubric + rules are LOCKED in docs/SCRM-DEMO-DESIGN.md §4 / GROUND_TRUTH.md:
 *   30  E1 FOCI → CYBER & PROHIBITED_SRC: 20 for the gap with roughly right magnitude
 *       and direction; +10 if confirmed it HOLDS WITHIN SECTOR (sector control).
 *   25  E2 single-source concentration → DELIVERY: 12 for the link; +13 if it identifies
 *       the MISSION-CRITICAL interaction (partial credit if found without the control).
 *   15  E3 FINANCIAL → DELIVERY: recovered as a real association without over-claiming
 *       causation (half credit if it asserts clean causation).
 *   20  Traps: small_business, established_year, contract_count, composite_risk_pct — per
 *       trap reported-as-real −5; explicit decline +5; silence +2.5. Clamp [0,20].
 *   10  Thin-subgroup caveat present (especially the n=2 non-concentrated MC cell).
 *
 * Output: a per-criterion breakdown (so a failure is diagnosable), never a bare number.
 * Deterministic and dependency-free.
 */

const fs = require("fs");
const path = require("path");

const TOLERANCE_PTS = 8; // ±8-point band for risk-score magnitude hits (scores are 0-100)
const R_TOLERANCE = 0.2; // ±0.2 band for a Pearson-r hit
const HERE = __dirname;

// The four documented traps (GROUND_TRUTH.md). `aliases` are substrings we accept in a
// finding's effect key / claim / declined entry so the scorer is robust to phrasing.
// `perShare` is each trap's slice of the 20.
const TRAPS = [
  { id: "small_business", aliases: ["small_business", "small business", "small-business", "business size", "sme"] },
  { id: "established_year", aliases: ["established_year", "established", "how long", "longevity", "year established", "supplier age", "age of the supplier", "how old"] },
  { id: "contract_count", aliases: ["contract_count", "contract count", "number of contracts", "more contracts", "count of contracts"] },
  { id: "composite_risk_pct", aliases: ["composite_risk_pct", "composite risk", "composite score", "precomputed composite", "composite roll", "roll-up score", "rollup score"] },
];

// Recognizes a "tested it, no real effect" statement. The leading
// `no (?:\w+\s+){0,3}<noun>` allows an adjective or two between "no" and the noun
// so natural phrasings land ("no consistent relationship", "no meaningful
// correlation", "no real effect"), plus the explicit verb/idiom forms.
const NULL_RE = /no (?:\w+\s+){0,3}(effect|relationship|difference|signal|association|link|driver|correlation|impact|pattern|bearing)|not (a )?(significant|real|meaningful|consistent|predictive|correlated|related)|independent|ruled out|no association|not predictive|noise|does not (drive|predict|relate|correlate|affect|explain)|is not (a )?(driver|predictor|related|correlated)|shows no|found no|detected no|no evidence/;

function loadAnswerKey() {
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
  return manifest.measured_effects;
}

// ── transcript flattening ────────────────────────────────────────────────────

function collectStructured(transcript) {
  const findings = [];
  const declined = [];
  for (const turn of Array.isArray(transcript) ? transcript : []) {
    const s = turn && turn.structured;
    if (!s || typeof s !== "object") continue;
    if (Array.isArray(s.findings)) findings.push(...s.findings.filter(Boolean));
    if (Array.isArray(s.declined)) declined.push(...s.declined.filter(Boolean));
  }
  return { findings, declined };
}

function lc(x) {
  return String(x == null ? "" : x).toLowerCase();
}

/**
 * Find the finding for a given effect. Match the STABLE effect key first (unambiguous),
 * then fall back to a claim-text predicate on DISTINGUISHING terms so one effect's
 * finding can't be reinterpreted as another's.
 * @param {object[]} findings
 * @param {string[]} effectKeys       substrings matched against f.effect
 * @param {(claim:string)=>boolean} [claimRequires]  fallback claim predicate
 */
function findByEffect(findings, effectKeys, claimRequires) {
  const wanted = effectKeys.map(lc);
  const byKey = findings.find((f) => wanted.some((k) => lc(f.effect).includes(k)));
  if (byKey) return byKey;
  if (typeof claimRequires === "function") {
    const KNOWN = ["foci_to_cyber", "ssconc_to_delivery", "financial_to_delivery"];
    return findings.find((f) => {
      const ek = lc(f.effect);
      const belongsElsewhere = KNOWN.some((k) => ek.includes(k) && !wanted.some((w) => ek.includes(w)));
      if (belongsElsewhere) return false;
      return claimRequires(lc(f.claim));
    });
  }
  return undefined;
}

function numbersIn(finding) {
  const out = [];
  const mag = finding && finding.magnitude;
  if (mag && typeof mag === "object") {
    for (const v of Object.values(mag)) {
      const n = Number(v);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  const claim = lc(finding && finding.claim);
  for (const m of claim.matchAll(/(\d+(?:\.\d+)?)\s*%?/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function withinTol(value, target, tol = TOLERANCE_PTS) {
  return Math.abs(value - target) <= tol;
}
function hasNear(finding, target, tol = TOLERANCE_PTS) {
  return numbersIn(finding).some((n) => withinTol(n, target, tol));
}

function hay(finding) {
  const caveats = (Array.isArray(finding.caveats) ? finding.caveats : []).map(lc).join(" ");
  return `${lc(finding.effect)} ${lc(finding.claim)} ${(Array.isArray(finding.controlled_for) ? finding.controlled_for : []).map(lc).join(" ")} ${caveats}`;
}

// ── criteria ─────────────────────────────────────────────────────────────────

function scoreEffect1(findings, key) {
  const max = 30;
  const k = key.effect1_foci_cyber_prohibited || {};
  const f = findByEffect(
    findings,
    ["foci_to_cyber", "foci"],
    (claim) => /foci|foreign (ownership|influence)/.test(claim) && /(cyber|prohibited|compliance|889|sanction)/.test(claim),
  );
  if (!f) return { key: "effect1_foci_cyber_prohibited", points: 0, max, note: "not reported" };

  const nums = numbersIn(f);
  const cyberPair = nums.some((n) => withinTol(n, k.cyber_foci)) && nums.some((n) => withinTol(n, k.cyber_non_foci));
  const prohPair = nums.some((n) => withinTol(n, k.prohibited_foci)) && nums.some((n) => withinTol(n, k.prohibited_non_foci));
  const gapHit = nums.some((n) => withinTol(n, k.cyber_foci - k.cyber_non_foci)) || nums.some((n) => withinTol(n, k.prohibited_foci - k.prohibited_non_foci));

  // Direction: FOCI value must exceed non-FOCI. Prefer labeled magnitude keys.
  let directionOk = false;
  const mag = f.magnitude && typeof f.magnitude === "object" ? f.magnitude : null;
  if (mag) {
    const fociKey = Object.keys(mag).find((kk) => /foci/i.test(kk) && !/non/i.test(kk));
    const nonKey = Object.keys(mag).find((kk) => /non[_-]?foci|other|non/i.test(kk));
    if (fociKey && nonKey) directionOk = Number(mag[fociKey]) > Number(mag[nonKey]);
  }
  if (!directionOk) {
    // Fallback: a value near a FOCI-truth exceeds a value near a non-FOCI-truth.
    directionOk =
      (nums.some((n) => withinTol(n, k.cyber_foci)) && nums.some((n) => withinTol(n, k.cyber_non_foci)) && k.cyber_foci > k.cyber_non_foci) ||
      (nums.some((n) => withinTol(n, k.prohibited_foci)) && nums.some((n) => withinTol(n, k.prohibited_non_foci)) && k.prohibited_foci > k.prohibited_non_foci) ||
      gapHit;
  }
  const magnitudeOk = cyberPair || prohPair || gapHit;
  if (!magnitudeOk || !directionOk) {
    return {
      key: "effect1_foci_cyber_prohibited",
      points: 0,
      max,
      note: `partial (magnitude=${magnitudeOk}, direction=${directionOk}) — no credit without the gap + direction`,
    };
  }

  // Sector control (+10).
  const controlled = Array.isArray(f.controlled_for) && f.controlled_for.map(lc).some((c) => c.includes("sector"));
  const sectorInText = /within[- ]?sector|holds .*sector|across .*sectors|sector control|independent of sector|not (a )?sector|each sector|per[- ]?sector/.test(hay(f));
  const sectorOk = controlled || sectorInText;
  const points = sectorOk ? 30 : 20;
  return {
    key: "effect1_foci_cyber_prohibited",
    points,
    max,
    note: sectorOk ? "gap + direction + holds within sector" : "gap + direction, but sector control not confirmed (−10)",
  };
}

function scoreEffect2(findings, key) {
  const max = 25;
  const k = key.effect2_ssconc_delivery_interaction || {};
  const f = findByEffect(
    findings,
    ["ssconc_to_delivery", "concentration", "single_source", "single-source", "single source"],
    (claim) => /(concentrat|single[- ]?source)/.test(claim) && /deliver|schedule/.test(claim),
  );
  if (!f) return { key: "effect2_ssconc_delivery_interaction", points: 0, max, note: "not reported" };

  const nums = numbersIn(f);
  const magnitudeOk =
    nums.some((n) => withinTol(n, k.delivery_mc_ssconc)) ||
    nums.some((n) => withinTol(n, k.delivery_nonmc_ssconc)) ||
    nums.some((n) => withinTol(n, k.delivery_mc_ssconc - k.delivery_mc_not)) || // MC gap ~35.9
    /higher|raises|elevat|increase|worse/.test(lc(f.claim));
  if (!magnitudeOk) {
    return { key: "effect2_ssconc_delivery_interaction", points: 0, max, note: "concentration→delivery link not substantiated" };
  }

  // Mission-Critical interaction (+13). The model may attach it to THIS finding
  // (controlled_for / claim) or split it into a SIBLING finding (e.g. a separate
  // "criticality_interaction": "the concentration→delivery link is amplified for
  // Mission-Critical suppliers"). Accept either structuring.
  const controlled = Array.isArray(f.controlled_for) && f.controlled_for.map(lc).some((c) => /critical/.test(c));
  const interactionInText = /mission[- ]?critical|criticality|interaction|only (for|when|among).*(critical)|depends on .*critical/.test(hay(f));
  const siblingInteraction = findings.some((g) => {
    if (g === f) return false;
    const gh = hay(g);
    const critControlled = Array.isArray(g.controlled_for) && g.controlled_for.map(lc).some((c) => /critical/.test(c));
    const mentionsCrit = critControlled || /mission[- ]?critical|criticality/.test(gh);
    const mentionsConc = /concentrat|single[- ]?source/.test(gh) || /ssconc|concentration/.test(lc(g.effect));
    const interactionWord = /amplif|interaction|depends on|only (for|when|among)|moderat/.test(gh) || /interaction/.test(lc(g.effect));
    return mentionsCrit && (mentionsConc || interactionWord);
  });
  const interactionOk = controlled || interactionInText || siblingInteraction;
  const points = interactionOk ? 25 : 12;
  return {
    key: "effect2_ssconc_delivery_interaction",
    points,
    max,
    note: interactionOk ? "link + Mission-Critical interaction" : "link found but Mission-Critical interaction missed (partial)",
  };
}

function scoreEffect3(findings, key) {
  const max = 15;
  const k = key.effect3_financial_delivery || {};
  const f = findByEffect(
    findings,
    ["financial_to_delivery", "financial"],
    (claim) => /financ/.test(claim) && /deliver|schedule/.test(claim),
  );
  if (!f) return { key: "effect3_financial_delivery", points: 0, max, note: "not reported" };

  const nums = numbersIn(f);
  const rHit =
    nums.some((n) => withinTol(n, k.r_financial_delivery, R_TOLERANCE)) ||
    nums.some((n) => n >= 0.5 && n <= 1.0);
  const wordHit = /(strong|moderate|positive).*(correlat|relationship|associat)|correlat.*(strong|moderate|positive)/.test(lc(f.claim));
  const recovered = rHit || wordHit;
  if (!recovered) {
    return { key: "effect3_financial_delivery", points: 0, max, note: "financial↔delivery association not substantiated" };
  }

  const h = hay(f);
  const overClaim = /\bcaus|drives|leads to|results in|because of financ|due to financ/.test(h) &&
    !/not .*caus|isn'?t caus|cannot .*caus|no.*caus|not necessarily caus/.test(h);
  if (overClaim) {
    return { key: "effect3_financial_delivery", points: max / 2, max, note: "association found but over-claims causation → half credit" };
  }
  return { key: "effect3_financial_delivery", points: max, max, note: "association found, causation not over-claimed" };
}

function scoreTraps(findings, declined) {
  const max = 20;
  const perShare = max / TRAPS.length; // 5
  const declinedText = declined.map(lc);
  const notes = [];
  let points = 0;
  for (const trap of TRAPS) {
    const asFinding = findings.find((f) => {
      const h = `${lc(f.effect)} ${lc(f.claim)}`;
      const matches = trap.aliases.some((a) => h.includes(a));
      if (!matches) return false;
      // A finding that itself says "no effect / independent / noise" is a decline, not a claim.
      return !NULL_RE.test(h);
    });
    const declinedExplicit = declinedText.some((d) => trap.aliases.some((a) => d.includes(a)));
    const declinedInline = findings.some((f) => {
      const h = `${lc(f.effect)} ${lc(f.claim)} ${(Array.isArray(f.caveats) ? f.caveats : []).map(lc).join(" ")}`;
      return trap.aliases.some((a) => h.includes(a)) && NULL_RE.test(h);
    });

    // A DECLARED decline wins: if the model listed the attribute in declined[] or
    // wrote a finding that states no effect, it did the right thing — even if it
    // also phrased the null result as a "finding" entry. Only a positive
    // driver-claim that is NOT declined counts as confabulation.
    if (declinedExplicit || declinedInline) {
      points += perShare;
      notes.push(`${trap.id}: declined / reported null (+${perShare})`);
    } else if (asFinding) {
      points -= perShare;
      notes.push(`${trap.id}: reported as REAL (−${perShare})`);
    } else {
      points += perShare / 2;
      notes.push(`${trap.id}: silent (+${perShare / 2})`);
    }
  }
  points = Math.max(0, Math.min(max, Math.round(points * 100) / 100));
  return { key: "traps_avoided", points, max, note: notes.join("; ") };
}

function scoreCaveats(transcript, findings) {
  const max = 10;
  const caveatHay = findings
    .flatMap((f) => (Array.isArray(f.caveats) ? f.caveats : []))
    .map(lc)
    .join(" ");
  const proseHay = (Array.isArray(transcript) ? transcript : [])
    .map((t) => lc(t && (t.prose || t.text)))
    .join(" ");
  const h = `${caveatHay} ${proseHay}`;
  const hit = /small (n|sample|subgroup|cell)|thin (cell|subgroup|sample)|n\s*[=<]\s*\d+|only \d+ suppliers?|low sample|runs counter|opposite direction|sampling (artefact|artifact)|underpowered|two suppliers/.test(h);
  return {
    key: "thin_subgroup_caveat",
    points: hit ? max : 0,
    max,
    note: hit ? "thin-subgroup / small-n caveat present" : "no thin-subgroup caveat",
  };
}

/**
 * Grade a transcript. `transcript` is an array of { structured, prose? }.
 * @returns {{ total:number, max:number, pct:number, criteria: object[] }}
 */
function scoreTranscript(transcript, answerKey = loadAnswerKey()) {
  const { findings, declined } = collectStructured(transcript);
  const criteria = [
    scoreEffect1(findings, answerKey),
    scoreEffect2(findings, answerKey),
    scoreEffect3(findings, answerKey),
    scoreTraps(findings, declined),
    scoreCaveats(transcript, findings),
  ];
  const total = criteria.reduce((s, c) => s + c.points, 0);
  const max = criteria.reduce((s, c) => s + c.max, 0);
  return {
    total: Math.round(total * 100) / 100,
    max,
    pct: Math.round((total / max) * 1000) / 10,
    criteria,
  };
}

function formatReport(result) {
  const lines = [`SCRM EVAL SCORE: ${result.total}/${result.max} (${result.pct}%)`, ""];
  for (const c of result.criteria) {
    lines.push(`  [${c.points}/${c.max}] ${c.key} — ${c.note}`);
  }
  return lines.join("\n");
}

module.exports = {
  scoreTranscript,
  formatReport,
  loadAnswerKey,
  collectStructured,
  TOLERANCE_PTS,
  R_TOLERANCE,
  TRAPS,
};
