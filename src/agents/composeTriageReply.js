/**
 * composeTriageReply — turn a triage specialist result into the reply shape the
 * index.js handlers expect from getAiResponse: { text, uploads, runSideEffects }.
 *
 * The specialist already produced Slack-formatted prose (structured json stripped
 * out by defineAgent's extractStructured). For recommendation mode we append a
 * compact, deterministic RECOMMENDATION summary rendered from the structured
 * block, so the "which nurse" answer is consistent even if the prose is terse —
 * this is the seam M3's Block Kit card renders from.
 *
 * No canvas side effects for triage turns (recommendations post inline), so
 * runSideEffects is a no-op resolving to [] — matching getAiResponse's contract.
 */

function noopSideEffects() {
  return Promise.resolve([]);
}

/** Render a deterministic recommendation summary from the structured block. */
function renderRecommendation(rec) {
  if (!rec || typeof rec !== "object") return "";
  const lines = [];
  const pid = rec.patient_id ? ` for *${rec.patient_id}*` : "";
  lines.push(`*RECOMMENDATION${pid}*`);
  const ranked = Array.isArray(rec.ranked_nurses) ? rec.ranked_nurses : [];
  if (ranked.length === 0) {
    lines.push("- No candidate nurse could be ranked from the available data.");
  } else {
    ranked.slice(0, 5).forEach((n, i) => {
      const bits = [];
      if (typeof n.skill_match_pct === "number") bits.push(`skill match ${n.skill_match_pct}%`);
      if (typeof n.current_caseload === "number") bits.push(`caseload ${n.current_caseload}`);
      if (Array.isArray(n.missing_skills) && n.missing_skills.length) {
        bits.push(`missing ${n.missing_skills.join(", ")}`);
      }
      const meta = bits.length ? ` — ${bits.join(" · ")}` : "";
      const who = n.nurse_id || `candidate ${i + 1}`;
      const rationale = n.rationale ? `\n   ${n.rationale}` : "";
      lines.push(`${i + 1}. *${who}*${meta}${rationale}`);
    });
  }
  if (rec.unit_risk_note) {
    lines.push("");
    lines.push(`*UNIT RISK:* ${rec.unit_risk_note}`);
  }
  return lines.join("\n");
}

/**
 * @param {{ text?: string, structured?: object|null }} specResult
 * @param {object} aiParams  the original getAiResponse args (unused here but kept
 *   for signature parity with the supervisor's composeTriageReply(specResult, aiParams))
 * @returns {{ text: string, uploads: Array, runSideEffects: () => Promise<Array> }}
 */
function composeTriageReply(specResult, aiParams) {
  const structured = specResult && specResult.structured;
  let text = (specResult && specResult.text ? specResult.text : "").trim();

  // Recommendation mode: append the deterministic summary if the prose didn't
  // already lead with it. (Analysis-mode prose stands on its own.)
  if (structured && structured.mode === "recommendation" && structured.recommendation) {
    const summary = renderRecommendation(structured.recommendation);
    if (summary && !text.includes("*RECOMMENDATION")) {
      text = text ? `${text}\n\n${summary}` : summary;
    }
  }

  if (!text) {
    text = "I couldn't produce a triage answer for that. Please rephrase or add detail.";
  }

  return {
    text,
    uploads: [],
    runSideEffects: noopSideEffects,
  };
}

module.exports = { composeTriageReply, renderRecommendation };
