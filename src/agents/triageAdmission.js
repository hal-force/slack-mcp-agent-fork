/**
 * triageAdmission — the operational "patient admitted → recommend a nurse" flow
 * for the #nurse-triage channel (design M3).
 *
 * Two responsibilities, kept separate so the ranking is testable without Slack:
 *
 *   rankNurses(patientId, opts)   deterministic ranker over the triage tools:
 *                                 score = skill_match − workload penalty, best
 *                                 first. This is the ground-truth-consistent
 *                                 ordering the specialist should agree with; it
 *                                 also lets the channel post a card WITHOUT a live
 *                                 LLM call when we just need the operational answer.
 *
 *   handleAdmission({...}, deps)  post the admission notice + recommendation card
 *                                 into a channel. The Slack poster is INJECTED
 *                                 (deps.postMessage) — nothing here posts to a
 *                                 live channel on its own; the caller wires the
 *                                 Bolt client and is responsible for authorization.
 *
 * The specialist (LLM) narrative is OPTIONAL: when deps.specialist is provided,
 * its analysis prose is added to the card as context. Both read the same tools,
 * so the numbers agree.
 */

const { dispatchTriageTool } = require("./triageTools");
const { buildAdmissionNotice, buildRecommendationCard } = require("./triageCard");

/**
 * Deterministic candidate ranking. score = skill_match_pct − workloadPenalty ×
 * (caseload / max_caseload) × 100, so a fully-loaded nurse is penalized up to the
 * penalty weight in skill-match points. Ties break by lower caseload then id.
 *
 * @param {string} patientId
 * @param {object} [opts]
 * @param {string} [opts.unit]           restrict to a home_unit
 * @param {string} [opts.shift_pattern]  restrict to a shift
 * @param {number} [opts.workloadPenalty=20]  max skill-match points a full load costs
 * @param {object} [opts.toolOpts]       injected into dispatchTriageTool (test seam)
 * @returns {Promise<{ patient: object|null, ranking: object[] }>}
 */
async function rankNurses(patientId, opts = {}) {
  const workloadPenalty = typeof opts.workloadPenalty === "number" ? opts.workloadPenalty : 20;
  const toolOpts = opts.toolOpts || {};

  const listing = await dispatchTriageTool(
    "triage_list_nurses_on_shift",
    { unit: opts.unit, shift_pattern: opts.shift_pattern, patient_id: patientId },
    toolOpts,
  );
  const nurses = Array.isArray(listing.nurses) ? listing.nurses : [];

  const scored = nurses.map((n) => {
    const match = typeof n.skill_match_pct === "number" ? n.skill_match_pct : 0;
    const cap = typeof n.max_caseload === "number" && n.max_caseload > 0 ? n.max_caseload : null;
    const loadFrac = cap ? Math.min(1, (n.current_caseload || 0) / cap) : 0;
    const score = Math.round((match - workloadPenalty * loadFrac) * 10) / 10;
    return { ...n, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((a.current_caseload || 0) !== (b.current_caseload || 0)) {
      return (a.current_caseload || 0) - (b.current_caseload || 0);
    }
    return String(a.nurse_id).localeCompare(String(b.nurse_id));
  });

  // Look up the patient facts for the admission notice.
  let patient = null;
  const pRes = await dispatchTriageTool(
    "triage_query",
    { table: "patients", filters: [{ field: "patient_id", op: "eq", value: patientId }] },
    toolOpts,
  );
  // triage_query returns aggregates; for the raw patient row, read the tables via
  // a count group_by trick is overkill — instead pull from the loaded tables.
  if (toolOpts.tables) {
    patient = (toolOpts.tables.patients || []).find((p) => p.patient_id === patientId) || null;
  } else {
    const { loadTables } = require("./triageData");
    patient = (loadTables(toolOpts.dataDir).patients || []).find((p) => p.patient_id === patientId) || null;
  }
  void pRes;

  return { patient, ranking: scored };
}

/**
 * Post the admission notice + recommendation card into a channel.
 *
 * @param {object} params
 * @param {string} params.patientId
 * @param {string} params.channel               target channel id (e.g. #nurse-triage)
 * @param {string} [params.unit]
 * @param {string} [params.shift_pattern]
 * @param {object} deps
 * @param {(msg:{channel:string,text:string,blocks:object[]})=>Promise<any>} deps.postMessage
 *   REQUIRED. Injected Slack poster (e.g. client.chat.postMessage). The caller
 *   owns authorization to post into the channel.
 * @param {{ run:(env:object)=>Promise<{text:string,structured:object|null}> }} [deps.specialist]
 *   OPTIONAL. When present, its analysis prose is attached to the card.
 * @param {object} [deps.rankOpts]  passed to rankNurses (e.g. toolOpts for tests)
 * @returns {Promise<{ notice:object, card:object, ranking:object[] }>}
 */
async function handleAdmission(params, deps) {
  const { patientId, channel, unit, shift_pattern: shiftPattern } = params || {};
  const { postMessage, specialist = null, rankOpts = {} } = deps || {};
  if (typeof postMessage !== "function") {
    throw new Error("handleAdmission: deps.postMessage is required (no implicit channel posting)");
  }
  if (!patientId) throw new Error("handleAdmission: patientId is required");
  if (!channel) throw new Error("handleAdmission: channel is required");

  const { patient, ranking } = await rankNurses(patientId, { unit, shift_pattern: shiftPattern, ...rankOpts });

  // Optional specialist narrative (advisory context on the card).
  let analysisNote = "";
  if (specialist && typeof specialist.run === "function") {
    try {
      const prompt =
        `Patient ${patientId} was just admitted${unit ? ` to ${unit}` : ""}. In two or three sentences, ` +
        `explain which on-shift nurse is the best assignment and how it affects the unit's risk profile. ` +
        `Be concise; the ranked list is shown separately.`;
      const res = await specialist.run({ aiParams: { userMessage: prompt }, intents: ["triage"] });
      analysisNote = (res && res.text ? res.text : "").trim();
    } catch (_) {
      analysisNote = ""; // specialist failure must not block the operational card
    }
  }

  const notice = buildAdmissionNotice(patient || { patient_id: patientId });
  const card = buildRecommendationCard(ranking, patient || { patient_id: patientId }, {
    analysisNote: analysisNote || undefined,
  });

  await postMessage({ channel, text: notice.text, blocks: notice.blocks });
  const cardPost = await postMessage({ channel, text: card.text, blocks: card.blocks });

  return { notice, card, ranking, cardPost };
}

module.exports = { rankNurses, handleAdmission };
