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

module.exports = { buildAdmissionNotice, buildRecommendationCard, nurseLine, SYNTH_TAG };
