/**
 * triageCard — Block Kit renderers for the #nurse-triage operational surface.
 *
 * Two cards, both PURE (data → blocks, no I/O), so they're fully unit-testable
 * and reused by both the channel-post driver (triageAdmission.js) and any future
 * event trigger:
 *
 *   buildAdmissionNotice(patient)              → "new admission" announcement
 *   buildRecommendationCard(ranking, patient)  → ranked-nurse recommendation
 *
 * `ranking` is the deterministic shape produced by triageAdmission.rankNurses
 * (also compatible with a specialist structured.recommendation): an array of
 * { nurse_id, nurse_name?, skill_match_pct, current_caseload, missing_skills[],
 *   score?, rationale? }, best first.
 *
 * All output is advisory + SYNTHETIC; the notice says so, since this posts into a
 * channel where a human charge nurse makes the actual call.
 */

const SYNTH_TAG = "SYNTHETIC demo data · advisory only — the charge nurse decides.";

function truncate(s, n) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function fmtPct(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${v}%` : "n/a";
}

/**
 * @param {object} patient  a row from patients.csv (or a subset)
 * @returns {{ text: string, blocks: object[] }}
 */
function buildAdmissionNotice(patient = {}) {
  const pid = patient.patient_id || "PT????";
  const name = patient.patient_name ? ` — ${patient.patient_name}` : "";
  const acuity = patient.acuity_level || "unknown acuity";
  const dx = patient.diagnosis || "diagnosis pending";
  const como = patient.comorbidity && String(patient.comorbidity).toLowerCase() !== "none"
    ? patient.comorbidity
    : "none recorded";
  const facts = [
    `*Patient:* ${pid}`,
    `*Acuity:* ${acuity}`,
    `*Diagnosis:* ${truncate(dx, 120)}`,
    `*Comorbidity:* ${truncate(como, 120)}`,
  ];
  if (patient.age || patient.sex) {
    facts.push(`*Demographics:* ${[patient.age, patient.sex].filter(Boolean).join(" · ")}`);
  }
  if (patient.symptoms) facts.push(`*Presenting:* ${truncate(patient.symptoms, 200)}`);

  const blocks = [
    { type: "header", text: { type: "plain_text", text: truncate(`🏥 New admission: ${pid}${name}`, 150), emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: facts.join("\n") } },
    { type: "context", elements: [{ type: "mrkdwn", text: SYNTH_TAG }] },
  ];
  return { text: `New admission: ${pid} (${acuity})`, blocks };
}

/** One ranked-nurse line as a mrkdwn string. */
function nurseLine(n, idx) {
  const who = n.nurse_name ? `${n.nurse_name} (${n.nurse_id})` : n.nurse_id || `candidate ${idx + 1}`;
  const bits = [`skill match ${fmtPct(n.skill_match_pct)}`];
  if (typeof n.current_caseload === "number") {
    const cap = typeof n.max_caseload === "number" ? `/${n.max_caseload}` : "";
    bits.push(`caseload ${n.current_caseload}${cap}`);
  }
  if (Array.isArray(n.missing_skills) && n.missing_skills.length) {
    bits.push(`missing ${n.missing_skills.slice(0, 4).join(", ")}${n.missing_skills.length > 4 ? "…" : ""}`);
  }
  const medal = idx === 0 ? "🥇 " : idx === 1 ? "🥈 " : idx === 2 ? "🥉 " : `${idx + 1}. `;
  const rationale = n.rationale ? `\n   _${truncate(n.rationale, 200)}_` : "";
  return `${medal}*${who}* — ${bits.join(" · ")}${rationale}`;
}

/**
 * Deterministic "why this pick" rationale for the top-ranked nurse — 2–3 sentences
 * grounded ONLY in fields already on the card: the patient's acuity/diagnosis/
 * comorbidity (how complex the case is) and the top candidate's skill match, missing
 * skills, credentials, caseload headroom, and score margin over the runner-up. No LLM:
 * it always renders, adds no latency, and can't over-claim beyond the data. Returns ""
 * when there is no candidate.
 *
 * @param {object} patient
 * @param {object[]} ranking  best-first nurse candidates
 * @returns {string}
 */
function buildTopPickRationale(patient = {}, ranking = []) {
  const top = ranking[0];
  if (!top) return "";
  const pid = patient.patient_id || "The patient";
  const acuity = String(patient.acuity_level || "").trim();
  const dx = String(patient.diagnosis || "").trim();
  const comoRaw = String(patient.comorbidity || "").trim();
  const como = comoRaw && comoRaw.toLowerCase() !== "none" ? comoRaw : "";
  const who = top.nurse_name ? `${top.nurse_name} (${top.nurse_id})` : top.nurse_id || "the top candidate";

  // 1) The case — how complex is it.
  const caseDesc = acuity ? `${acuity}-acuity admission` : "new admission";
  let detail = "";
  if (dx && como) detail = ` (${truncate(dx, 60)}; comorbidity: ${truncate(como, 40)})`;
  else if (dx) detail = ` (${truncate(dx, 60)})`;
  else if (como) detail = ` (comorbidity: ${truncate(como, 40)})`;
  const s1 = `${pid} is a ${caseDesc}${detail}.`;

  // 2) Nurse ↔ issue alignment.
  const match = typeof top.skill_match_pct === "number" ? top.skill_match_pct : null;
  const missing = Array.isArray(top.missing_skills) ? top.missing_skills : [];
  const creds = [];
  if (top.certification && String(top.certification).toLowerCase() !== "none") creds.push(String(top.certification));
  if (typeof top.experience_years === "number" && top.experience_years > 0) creds.push(`${top.experience_years} yrs`);
  const credStr = creds.length ? ` (${creds.join(", ")})` : "";
  const load =
    typeof top.current_caseload === "number" && typeof top.max_caseload === "number" && top.max_caseload > 0
      ? ` and has caseload headroom (${top.current_caseload}/${top.max_caseload})`
      : "";
  let fit;
  if (match !== null && missing.length === 0) {
    fit = `${who}${credStr} is the strongest fit, covering all of the patient's required skills (${match}% match)${load}`;
  } else if (match !== null) {
    const ids = missing.slice(0, 3).join(", ") + (missing.length > 3 ? "…" : "");
    fit = `${who}${credStr} leads at ${match}% skill match — short ${missing.length} competenc${missing.length === 1 ? "y" : "ies"} (${ids})${load}`;
  } else {
    fit = `${who}${credStr} is the top-ranked available nurse${load}`;
  }
  const s2 = `${fit}.`;

  // 3) Trade-off vs the runner-up, plus an honest gap caveat.
  let s3 = "";
  const rup = ranking[1];
  if (rup && typeof top.score === "number" && typeof rup.score === "number" && top.score > rup.score) {
    s3 += ` It edges ${rup.nurse_id || "the next candidate"} on the combined skill/workload score (${top.score} vs ${rup.score}) while keeping the assignment within a safe caseload.`;
  }
  if (missing.length) {
    s3 += ` Pair with a resource nurse for the uncovered skill${missing.length > 1 ? "s" : ""}.`;
  }
  return `${s1} ${s2}${s3}`.trim();
}

/**
 * @param {object[]} ranking  best-first nurse candidates
 * @param {object} patient
 * @param {{ unitRiskNote?: string, analysisNote?: string }} [extra]
 * @returns {{ text: string, blocks: object[] }}
 */
function buildRecommendationCard(ranking = [], patient = {}, extra = {}) {
  const pid = patient.patient_id || "PT????";
  const top = ranking[0];
  const headline = top
    ? `Recommend ${top.nurse_name ? top.nurse_name + " " : ""}${top.nurse_id || ""} for ${pid}`
    : `No recommendation for ${pid}`;

  const blocks = [
    { type: "header", text: { type: "plain_text", text: truncate(`🩺 Triage recommendation: ${pid}`, 150), emoji: true } },
  ];

  if (!ranking.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "No candidate nurse could be ranked from the available data." },
    });
  } else {
    const lines = ranking.slice(0, 5).map((n, i) => nurseLine(n, i));
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*RANKED CANDIDATES*\n${lines.join("\n")}` } });
    const rationale = buildTopPickRationale(patient, ranking);
    if (rationale) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*WHY THIS PICK*\n${truncate(rationale, 700)}` } });
    }
  }

  if (extra.unitRiskNote) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*UNIT RISK*\n${truncate(extra.unitRiskNote, 500)}` } });
  }
  if (extra.analysisNote) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(extra.analysisNote, 1200) } });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: SYNTH_TAG }] });

  return { text: headline, blocks };
}

module.exports = { buildAdmissionNotice, buildRecommendationCard, buildTopPickRationale, nurseLine, SYNTH_TAG };
