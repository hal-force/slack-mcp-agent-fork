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

// The four documented traps (GROUND_TRUTH.md). `aliases` are whole-word phrases we accept
// in a finding's effect key / claim / declined entry so the scorer is robust to phrasing.
// `declinedOnly` are looser terms accepted only inside declined[] (a list of attribute
// names, where "established" can only mean the trap — in a claim it is an ordinary verb).
const TRAPS = [
  { id: "small_business", aliases: ["small_business", "small business", "small-business", "business size", "sme"], declinedOnly: [] },
  { id: "established_year", aliases: ["established_year", "year established", "years established", "establishment year", "how long", "longevity", "supplier age", "age of the supplier", "age of supplier", "how old", "years in business", "founding year"], declinedOnly: ["established", "age"] },
  { id: "contract_count", aliases: ["contract_count", "contract count", "number of contracts", "more contracts", "count of contracts"], declinedOnly: [] },
  { id: "composite_risk_pct", aliases: ["composite_risk_pct", "composite risk", "composite score", "precomputed composite", "composite roll", "roll-up score", "rollup score"], declinedOnly: ["composite"] },
];

function escapeRe(x) {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Word-boundary alias match (plain substring matching let "sme" hit "assessment").
function mentionsAny(text, aliases) {
  return aliases.some((a) => new RegExp(`(^|[^a-z0-9])${escapeRe(a)}($|[^a-z0-9])`).test(text));
}

// Recognizes a "tested it, no real effect" statement. The leading
// `no (?:\w+\s+){0,3}<noun>` allows an adjective or two between "no" and the noun
// so natural phrasings land ("no consistent relationship", "no meaningful
// correlation", "no real effect"), plus the explicit verb/idiom forms.
// Bare "independent" is deliberately NOT here: "riskier, independent of sector" is a
// positive claim with a control, not a null.
const NULL_RE = /no (?:\w+\s+){0,3}(effect|relationship|difference|signal|association|link|driver|correlation|impact|pattern|bearing)|not (a )?(significant|real|meaningful|consistent|predictive|correlated|related)|(is|are|was|were|appears?|looks?) (statistically )?independent of (risk|overall risk|delivery|cyber)|ruled out|no association|not predictive|noise|does not (drive|predict|relate|correlate|affect|explain)|is not (a )?(driver|predictor|related|correlated)|shows no|found no|detected no|no evidence/;

// A negator in the few words before a match flips it ("does not hold within sector",
// "no interaction with criticality", "not causal").
const NEG_BEFORE_RE = /\b(no|not|never|without|cannot|neither|nor)\b|n't\b/;

/**
 * True when `re` matches somewhere in `text` WITHOUT a negator in the preceding five
 * words of the same sentence.
 */
function affirmed(text, re) {
  const t = lc(text);
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of t.matchAll(g)) {
    const before = t.slice(0, m.index).split(/[.;!?\n]/).pop().trim().split(/\s+/).slice(-5).join(" ");
    if (!NEG_BEFORE_RE.test(before)) return true;
  }
  return false;
}

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
  for (const m of claim.matchAll(/(?<![\w.])([-\u2212]?\d+(?:\.\d+)?)\s*%?/g)) {
    const n = Number(m[1].replace("\u2212", "-"));
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

// The agent's own (FOCI, non-FOCI) pair from labeled magnitude keys, optionally for one
// KRI (keys containing `kri`). null when the finding doesn't label both groups.
function fociPair(mag, kri) {
  if (!mag || typeof mag !== "object") return null;
  const keys = Object.keys(mag).filter((kk) => !kri || kk.toLowerCase().includes(kri));
  const nonKey = keys.find((kk) => /non[_-]?foci|other|non|false|\bno\b/i.test(kk));
  const fociKey = keys.find((kk) => kk !== nonKey && (/foci/i.test(kk) || /true|\byes\b/i.test(kk)) && !/non|other|false/i.test(kk));
  if (!fociKey || !nonKey) return null;
  const foci = Number(mag[fociKey]);
  const non = Number(mag[nonKey]);
  return Number.isFinite(foci) && Number.isFinite(non) ? { foci, non } : null;
}

/**
 * Grade one FOCI finding for the gap + direction. The CROSS-KRI link is the effect, so
 * a pair must match the SAME KRI's truths (cyber or prohibited-source), and a gap must be
 * the agent's own FOCI − non-FOCI difference — never "any number near any target"
 * (an overall-risk mean of 53.8 once passed because it sat near the 50.6 prohibited gap).
 */
function gradeFociFinding(f, k) {
  const mag = f.magnitude && typeof f.magnitude === "object" ? f.magnitude : null;
  const kris = [
    { kri: "cyber", foci: k.cyber_foci, non: k.cyber_non_foci },
    { kri: "prohib", foci: k.prohibited_foci, non: k.prohibited_non_foci },
  ];
  const claim = lc(f.claim);
  const claimKri = (x) => (x === "cyber" ? /cyber/.test(claim) : /prohibit|889|compliance/.test(claim));
  let magnitudeOk = false;
  let directionOk = false;
  let labeled = false;
  // Generic keys ("foci_true"/"foci_false") are attributed to a KRI only when the keys
  // name no KRI themselves and the claim names exactly one KRI — otherwise cyber values
  // could be scored against the prohibited-source truths.
  const keysNameKri = mag && Object.keys(mag).some((kk) => /cyber|prohib/i.test(kk));
  const claimKris = kris.filter((t) => claimKri(t.kri));
  for (const t of kris) {
    const generic = !keysNameKri && claimKris.length === 1 && claimKris[0] === t ? fociPair(mag, "") : null;
    const p = fociPair(mag, t.kri) || generic;
    if (!p) continue;
    labeled = true;
    const pairHit = withinTol(p.foci, t.foci) && withinTol(p.non, t.non);
    const gapHit = withinTol(p.foci - p.non, t.foci - t.non);
    if (pairHit || gapHit) magnitudeOk = true;
    if (p.foci > p.non) directionOk = true;
  }
  if (!labeled) {
    // Unlabeled: a stated gap in the claim, for a KRI the claim names, and the claim
    // must say FOCI is higher.
    const nums = numbersIn({ claim: f.claim });
    magnitudeOk = kris.some((t) => claimKri(t.kri) && nums.some((n) => withinTol(n, t.foci - t.non)));
    const saysHigher = affirmed(claim, /\b(higher|greater|more|elevated|exceed\w*|above|worse|outscore\w*)\b/);
    const saysLower = affirmed(claim, /\b(lower|less|below|fewer|better)\b/);
    directionOk = saysHigher && !saysLower;
  }
  return { magnitudeOk, directionOk };
}

function sectorControl(f) {
  const h = hay(f);
  const controlled = Array.isArray(f.controlled_for) && f.controlled_for.map(lc).some((c) => c.includes("sector"));
  const inText =
    affirmed(h, /within[- ]?(each |every )?sectors?|holds [^.;]*sectors?|across [^.;]*sectors|sector control|independent of sector|each sector|every sector|per[- ]?sector/) ||
    /\bnot (a |an |the )?(sector (confound|effect|artifact|artefact)|(due to|driven by|explained by|confounded by|attributable to) (the )?sector)/.test(h);
  // "does not hold within sector" / "explained by sector" = the agent concluded the
  // OPPOSITE of the key; listing "sector" in controlled_for doesn't rescue that.
  const refuted =
    /\b(not|n't|fails? to)\s+(\w+\s+){0,2}(hold|survive|persist)[^.;]*sector/.test(h) ||
    affirmed(h, /(disappears?|vanish\w*|revers\w*|explained by|driven by|confounded by|attributable to)[^.;]{0,30}sector/);
  return { confirmed: controlled || inText, refuted };
}

function scoreEffect1(findings, key) {
  const max = 30;
  const k = key.effect1_foci_cyber_prohibited || {};
  const isFoci = (f) => /foci/.test(lc(f.effect)) || /foci|foreign (ownership|influence)/.test(lc(f.claim));
  const candidates = findings.filter(isFoci);
  if (candidates.length === 0) return { key: "effect1_foci_cyber_prohibited", points: 0, max, note: "not reported" };

  const grades = candidates.map((f) => gradeFociFinding(f, k));
  const hit = grades.find((g) => g.magnitudeOk && g.directionOk);
  if (!hit) {
    const anyMag = grades.some((g) => g.magnitudeOk);
    const anyDir = grades.some((g) => g.directionOk);
    return {
      key: "effect1_foci_cyber_prohibited",
      points: 0,
      max,
      note: `partial (magnitude=${anyMag}, direction=${anyDir}) — no credit without the gap + direction`,
    };
  }

  // Sector control (+10): on the gap finding itself OR a sibling FOCI finding (the
  // model often reports the within-sector check as its own finding). Any FOCI finding
  // that says the gap does NOT survive the sector control vetoes the credit.
  const controls = candidates.map(sectorControl);
  const sectorOk = controls.some((c) => c.confirmed) && !controls.some((c) => c.refuted);
  return {
    key: "effect1_foci_cyber_prohibited",
    points: sectorOk ? 30 : 20,
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
    affirmed(f.claim, /higher|raises|elevat|increase|worse/);
  if (!magnitudeOk) {
    return { key: "effect2_ssconc_delivery_interaction", points: 0, max, note: "concentration→delivery link not substantiated" };
  }

  // Mission-Critical interaction (+13). The model may attach it to THIS finding
  // (controlled_for / claim) or split it into a SIBLING finding (e.g. a separate
  // "criticality_interaction": "the concentration→delivery link is amplified for
  // Mission-Critical suppliers"). Accept either structuring.
  // "no interaction with criticality", "regardless of criticality", "holds equally across
  // criticality levels" all say there is NO interaction — the opposite of the key.
  const interactionRefuted = (h) =>
    /\b(no|not|n't)\b\W+(?:\w+\W+){0,4}(interact\w*|depend\w*|differ\w*|vary|varies|moderat\w*|amplif\w*)\b[^.;]*critical/.test(h) ||
    /critical\w*[^.;]*\b(no|not|n't)\b\W+(?:\w+\W+){0,3}(interact\w*|depend\w*|differ\w*|matter\w*)/.test(h) ||
    /(regardless|irrespective) of [^.;]*critical|(equally|similarly|consistent(ly)?) across [^.;]*critical/.test(h);
  const h2 = hay(f);
  const controlled = Array.isArray(f.controlled_for) && f.controlled_for.map(lc).some((c) => /critical/.test(c));
  const interactionInText = affirmed(h2, /mission[- ]?critical|criticality|interaction|only (for|when|among)[^.;]*critical|depends on [^.;]*critical/);
  const siblingInteraction = findings.some((g) => {
    if (g === f) return false;
    const gh = hay(g);
    if (interactionRefuted(gh)) return false;
    const critControlled = Array.isArray(g.controlled_for) && g.controlled_for.map(lc).some((c) => /critical/.test(c));
    const mentionsCrit = critControlled || affirmed(gh, /mission[- ]?critical|criticality/);
    const mentionsConc = /concentrat|single[- ]?source/.test(gh) || /ssconc|concentration/.test(lc(g.effect));
    const interactionWord = affirmed(gh, /amplif|interaction|depends on|only (for|when|among)|moderat/) || /interaction/.test(lc(g.effect));
    return mentionsCrit && (mentionsConc || interactionWord);
  });
  const interactionOk = ((controlled || interactionInText) && !interactionRefuted(h2)) || siblingInteraction;
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
  // Signed: r = -0.76 is the wrong relationship, not a hit.
  const rHit = nums.some((n) => withinTol(n, k.r_financial_delivery, R_TOLERANCE));
  const claim3 = lc(f.claim);
  const wordHit =
    affirmed(claim3, /(strong|moderate|positive)[^.;]*(correlat|relationship|associat)|correlat[^.;]*(strong|moderate|positive)/) &&
    !/\b(negative|inverse)\b/.test(claim3);
  const recovered = rHit || wordHit;
  if (!recovered) {
    return { key: "effect3_financial_delivery", points: 0, max, note: "financial↔delivery association not substantiated" };
  }

  // Judged on the claim only, with a local negation window: "correlation, not causation"
  // is fine; "distress causes delays" is not. A caveat naming a common driver ("archetype
  // drives both") is the confound note the key asks for, not an over-claim.
  const overClaim = affirmed(claim3, /\bcaus(es|ed|ing|al|ally|ation)\b|leads? to|results? in|because of financ|due to financ|financ\w*[^.;]{0,40}\bdrives?\b/);
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
    // Effect key + claim only: a caveat's "no evidence of causation" must not turn a
    // positive trap claim into a decline.
    const text = (f) => `${lc(f.effect).replace(/_/g, " ")} ${lc(f.effect)} ${lc(f.claim)}`;
    const asFinding = findings.find((f) => {
      const h = text(f);
      // A finding that itself says "no effect / ruled out / noise" is a decline, not a claim.
      return mentionsAny(h, trap.aliases) && !NULL_RE.test(h);
    });
    const declinedExplicit = declinedText.some((d) => mentionsAny(d.replace(/_/g, " "), [...trap.aliases, ...trap.declinedOnly]) || mentionsAny(d, trap.aliases));
    const declinedInline = findings.some((f) => {
      const h = text(f);
      return mentionsAny(h, trap.aliases) && NULL_RE.test(h);
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
  // Every finding cites an n, so "n=40" is not a caveat — only a small cited cell is.
  const SMALL_N = 10;
  const smallCitedN = [...h.matchAll(/\bn\s*(?:=|<|<=|\u2264)\s*(\d+)|only (\d+) suppliers?/g)].some((m) => Number(m[1] || m[2]) <= SMALL_N);
  const hit =
    smallCitedN ||
    affirmed(h, /small (n|sample|subgroup|cell)|thin (cell|subgroup|sample)|low sample|runs counter|opposite direction|sampling (artefact|artifact)|underpowered|two suppliers/);
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
