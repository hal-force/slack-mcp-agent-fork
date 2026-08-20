/**
 * score.js — grades a triage-specialist transcript against the answer key.
 *
 * ── Separation contract ──────────────────────────────────────────────────
 * This file lives in the QUARANTINE (tests/eval/triage) and is the ONLY code
 * permitted to read the answer key (manifest.json / GROUND_TRUTH.md). It is a
 * SCORER, never part of any agent path. run-agent.js (which drives the agent)
 * must never require this module or the answer key. See README.md here.
 *
 * ── What it grades ─────────────────────────────────────────────────────────
 * Input: a transcript = an array of per-question results, each { structured } as
 * emitted by the specialist (defineAgent parses the trailing ```json block into
 * `structured`). The scorer merges findings/declined across all questions (the
 * agent may surface an effect under any question) and grades the merged view.
 *
 * Rubric + rules are LOCKED in docs/MULTI-AGENT-TRIAGE-DESIGN.md §11:
 *   30  Effect 1 (AI vs Manual skill match): direction right AND both means within
 *       ±8 pts of the realized magnitudes.
 *   30  Effect 2 (skill match → outcome): full only if controlled_for includes
 *       acuity; HALF (15) if the effect is found but not acuity-controlled.
 *   15  Effect 4 (comorbidity): flat effect claimed AND no per-type over-claim.
 *   15  Traps: start full; per trap reported-as-real −(15/6); explicit decline of
 *       a trap scores higher than silence (silence = half that trap's share).
 *   10  Small-subgroup caveat present.
 *
 * Output: a per-criterion breakdown (so a failure is diagnosable), never a bare
 * number. Deterministic and dependency-free.
 */

const fs = require("fs");
const path = require("path");

const TOLERANCE_PTS = 8; // locked ±8-point band for magnitude hits
const HERE = __dirname;

// The six documented traps (GROUND_TRUTH.md). Keyed by a stable id; `aliases`
// are substrings we accept in a finding's effect key / claim / declined entry so
// the scorer is robust to phrasing. `perShare` is each trap's slice of the 15.
const TRAPS = [
  { id: "nurse_experience", aliases: ["experience", "nurse_experience", "years"] },
  { id: "unit_risk", aliases: ["unit", "ward"] },
  { id: "diagnosis_independent_of_acuity", aliases: ["diagnosis", "diagnos"] },
  { id: "night_shift_risk", aliases: ["shift", "night"] },
  { id: "sex", aliases: ["sex", "gender"] },
  { id: "age", aliases: ["age"] },
];

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
 * Find the finding for a given effect.
 *
 * Match on the STABLE effect key first (the specialist is prompted to emit
 * ai_vs_manual_skill_match / skill_match_to_outcome / comorbidity_risk / …), which
 * is unambiguous. Only if no finding carries a recognizable effect key do we fall
 * back to claim-text matching, and then only with a `claimRequires` predicate that
 * uses DISTINGUISHING terms — so effect 2's "skill match" phrasing can't
 * accidentally capture effect 1's AI-vs-Manual finding (both mention skill match).
 *
 * @param {object[]} findings
 * @param {string[]} effectKeys       substrings matched against f.effect
 * @param {(claim:string)=>boolean} [claimRequires]  fallback claim predicate
 */
function findByEffect(findings, effectKeys, claimRequires) {
  const wanted = effectKeys.map(lc);
  const byKey = findings.find((f) => wanted.some((k) => lc(f.effect).includes(k)));
  if (byKey) return byKey;
  if (typeof claimRequires === "function") {
    return findings.find((f) => {
      // Don't let a finding that clearly belongs to a DIFFERENT known effect be
      // reinterpreted via claim text.
      const ek = lc(f.effect);
      const belongsElsewhere = ["ai_vs_manual", "comorbidity_risk", "skill_match_to_outcome", "skill_match_to_los"].some(
        (k) => ek.includes(k) && !wanted.some((w) => ek.includes(w)),
      );
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
  // Also scrape numbers out of the claim string as a fallback.
  const claim = lc(finding && finding.claim);
  for (const m of claim.matchAll(/(\d+(?:\.\d+)?)\s*%?/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function withinTol(value, target) {
  return Math.abs(value - target) <= TOLERANCE_PTS;
}

/** Is there a number within ±tol of `target` among a finding's numbers? */
function hasNear(finding, target) {
  return numbersIn(finding).some((n) => withinTol(n, target));
}

// ── criteria ─────────────────────────────────────────────────────────────────

function scoreEffect1(findings, key) {
  const max = 30;
  const f = findByEffect(
    findings,
    ["ai_vs_manual", "assignment_method"],
    (claim) => /\bai[- ]?recommended\b|\bmanual\b/.test(claim) && /assign|match/.test(claim),
  );
  if (!f) return { key: "effect1_ai_vs_manual", points: 0, max, note: "not reported" };
  const ai = key.mean_skill_match_ai_pct;
  const man = key.mean_skill_match_manual_pct;
  const nums = numbersIn(f);
  const hitAi = nums.some((n) => withinTol(n, ai));
  const hitMan = nums.some((n) => withinTol(n, man));
  // Direction: the reported AI value should exceed the reported Manual value.
  // Use the magnitude object if labeled, else infer from the two closest numbers.
  let directionOk = false;
  const mag = f.magnitude && typeof f.magnitude === "object" ? f.magnitude : null;
  if (mag) {
    const aiKey = Object.keys(mag).find((k) => /ai/i.test(k));
    const manKey = Object.keys(mag).find((k) => /man/i.test(k));
    if (aiKey && manKey) directionOk = Number(mag[aiKey]) > Number(mag[manKey]);
  }
  if (!directionOk) {
    // Fallback: a value near AI-truth is larger than a value near Manual-truth.
    directionOk = hitAi && hitMan && ai > man;
  }
  if (directionOk && hitAi && hitMan) {
    return { key: "effect1_ai_vs_manual", points: max, max, note: `direction + both means within ±${TOLERANCE_PTS}` };
  }
  return {
    key: "effect1_ai_vs_manual",
    points: 0,
    max,
    note: `partial (direction=${directionOk}, ai±=${hitAi}, manual±=${hitMan}) — no credit without direction+both magnitudes`,
  };
}

function scoreEffect2(findings, key) {
  const max = 30;
  const f = findByEffect(
    findings,
    ["skill_match_to_outcome"],
    (claim) => /(skill match|match).*(adverse|outcome)|(adverse|outcome).*(skill match|match)/.test(claim),
  );
  if (!f) return { key: "effect2_skill_match_outcome", points: 0, max, note: "not reported" };
  // Effect must point the right way: higher skill match → lower adverse rate.
  const high = key.adverse_rate_high_skill_match_pct;
  const low = key.adverse_rate_low_skill_match_pct;
  const nums = numbersIn(f);
  const magnitudeOk = nums.some((n) => withinTol(n, high)) || nums.some((n) => withinTol(n, low)) ||
    // or a stated gap near (low-high)
    nums.some((n) => withinTol(n, Math.abs(low - high)));
  const controlled = Array.isArray(f.controlled_for) && f.controlled_for.map(lc).some((c) => c.includes("acuity"));
  if (!magnitudeOk && !controlled) {
    return { key: "effect2_skill_match_outcome", points: 0, max, note: "effect not substantiated" };
  }
  if (controlled) {
    return { key: "effect2_skill_match_outcome", points: max, max, note: "found AND controlled for acuity" };
  }
  return { key: "effect2_skill_match_outcome", points: max / 2, max, note: "found but NOT acuity-controlled → half credit" };
}

function scoreEffect4(findings) {
  const max = 15;
  const f = findByEffect(findings, ["comorbidity_risk", "comorbid"], (claim) => /comorbid/.test(claim));
  if (!f) return { key: "effect4_comorbidity", points: 0, max, note: "not reported" };
  // Over-claim guard: asserting a SPECIFIC comorbidity type carries different risk
  // is over-reading noise (effect is flat/uniform). Detect type-specific claims.
  const claim = lc(f.claim);
  const caveats = (Array.isArray(f.caveats) ? f.caveats : []).map(lc).join(" ");
  const hay = `${claim} ${caveats}`;
  const overClaim = /(cirrhosis|hypertension|diabetes|copd|ckd|hiv|cancer|obesity).*(higher|greater|worse|more risk)/.test(hay) ||
    /type[- ]?specific|per[- ]?type|certain comorbid/.test(hay) && !/uniform|flat|regardless|no.*type|same across/.test(hay);
  if (overClaim) {
    return { key: "effect4_comorbidity", points: 0, max, note: "over-claimed type-specific risk (effect is flat)" };
  }
  return { key: "effect4_comorbidity", points: max, max, note: "flat comorbidity effect, no type over-claim" };
}

function scoreTraps(findings, declined) {
  const max = 15;
  const perShare = max / TRAPS.length; // 2.5
  const declinedText = declined.map(lc);
  const notes = [];
  let points = 0;
  for (const trap of TRAPS) {
    // Reported as a REAL finding? (an entry in findings that matches the trap and
    // is NOT flagged as null/no-effect)
    const asFinding = findings.find((f) => {
      const hay = `${lc(f.effect)} ${lc(f.claim)}`;
      const matches = trap.aliases.some((a) => hay.includes(a));
      if (!matches) return false;
      // If the finding itself says "no effect / not significant / independent",
      // treat it as a decline, not a real claim.
      const declinesInline = /no (real )?(effect|relationship|difference|signal)|not significant|independent|ruled out|no association/.test(hay);
      return !declinesInline;
    });
    const declinedExplicit = declinedText.some((d) => trap.aliases.some((a) => d.includes(a)));
    const declinedInline = findings.some((f) => {
      const hay = `${lc(f.effect)} ${lc(f.claim)}`;
      return trap.aliases.some((a) => hay.includes(a)) &&
        /no (real )?(effect|relationship|difference|signal)|not significant|independent|ruled out|no association/.test(hay);
    });

    if (asFinding) {
      points -= perShare; // reported as real → penalty
      notes.push(`${trap.id}: reported as REAL (−${perShare})`);
    } else if (declinedExplicit || declinedInline) {
      points += perShare; // explicit decline → full share
      notes.push(`${trap.id}: explicitly declined (+${perShare})`);
    } else {
      points += perShare / 2; // silence → half share
      notes.push(`${trap.id}: silent (+${perShare / 2})`);
    }
  }
  // Clamp to [0, max].
  points = Math.max(0, Math.min(max, Math.round(points * 100) / 100));
  return { key: "traps_avoided", points, max, note: notes.join("; ") };
}

function scoreCaveats(transcript, findings) {
  const max = 10;
  // Any finding caveat, or prose, that flags a small subgroup / small n / a
  // subgroup running counter to the aggregate.
  const caveatHay = findings
    .flatMap((f) => (Array.isArray(f.caveats) ? f.caveats : []))
    .map(lc)
    .join(" ");
  const proseHay = (Array.isArray(transcript) ? transcript : [])
    .map((t) => lc(t && (t.prose || t.text)))
    .join(" ");
  const hay = `${caveatHay} ${proseHay}`;
  const hit = /small (n|sample|subgroup|cell)|n\s*[<]\s*\d+|low sample|runs counter|opposite direction|sampling artefact|artifact|underpowered/.test(hay);
  return {
    key: "small_subgroup_caveat",
    points: hit ? max : 0,
    max,
    note: hit ? "subgroup/sample-size caveat present" : "no small-subgroup caveat",
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
    scoreEffect4(findings),
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
  const lines = [`TRIAGE EVAL SCORE: ${result.total}/${result.max} (${result.pct}%)`, ""];
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
  TRAPS,
};
