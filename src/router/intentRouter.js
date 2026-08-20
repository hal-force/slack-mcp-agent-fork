/**
 * Canonical intent classification. Single source of truth for all tool-signal regex patterns.
 *
 * Replaces: TOOL_SIGNAL_RE in respond.js, looksTableauRelated() and
 * threadSuggestsTableauContext() in tableauMcpClient.js.
 */

const INTENTS = {
  TABLEAU:         "tableau",
  CANVAS:          "canvas",
  SLACK_SEARCH:    "slack_search",
  INTERNET_SEARCH: "internet_search",
  TRIAGE:          "triage",
  CONVERSATIONAL:  "conversational",
};

const ORIGINS = {
  DM_ASSISTANT:    "dm_assistant",
  CHANNEL_MENTION: "channel_mention",
  WORKFLOW:        "workflow",
};

const SIGNAL = {
  // Tableau is the agent's primary analytics surface, so route data-shaped
  // questions here even when the user never says "Tableau" — e.g. "find my
  // grants data", "show me the sales numbers". Fetching the datasource catalog
  // is cheap; the skill no-ops if nothing matches. slack_search may also fire
  // on the same turn — both skills contribute context in parallel.
  tableau:
    /\btableau\b|\bvizql\b|\bdatasources?\b|\bdata\s?sources?\b|\bworkbooks?\b|\bdashboards?\b|\bpulse\b|\bdatasets?\b|\bgrants?\b|\bmetrics?\b|\bkpis?\b|\banalytics\b|\breports?\b|\bfigures\b|\bnumbers\b|\bstatistics\b|\bstats\b|\bdata\b/i,
  canvas:
    /\bcanvas\b|\bcreate\b.*\bdoc(?:ument)?\b|\bdoc(?:ument)?\b.*\bcreate\b/i,
  // Long-form deliverables belong in a Canvas (a real multi-page doc) rather than
  // a terse chat reply. "generate a report", "write a brief/memo", "draft a
  // three-page write-up", "put together a detailed analysis for my exec" — these
  // route to the canvas skill so the full narrative lands in a document. Requires
  // an authoring verb near a document noun so casual mentions ("pull the latest
  // report") don't spuriously create a canvas. Tableau may fire on the same turn
  // to supply the underlying data.
  report:
    /\b(generate|write|create|draft|prepare|produce|compose|build|make|put together)\b[\s\S]{0,40}?\b(reports?|briefs?|memos?|write[- ]?ups?|deep dive|analys[ie]s|assessment|white ?paper|summary document|full summary)\b/i,
  slackSearch:
    /\bfind\b|\bsearch\b|\bwho (?:said|mentioned|posted)\b|\bshow me messages\b/i,
  // Nurse-assignment / triage operations. Deliberately NARROW: requires the
  // clinical-staffing vocabulary of this scenario (nurse/patient/admit/acuity/
  // assignment/skill-match/caseload/shift), so it does NOT fire on generic
  // analytics ("show me the sales numbers") the way SIGNAL.tableau does. The
  // TRIAGE intent is inert unless AGENTS_ENABLED is on AND a triage specialist is
  // wired in (see supervisor.js) — with the flag off it changes no behavior
  // (nothing downstream consumes it; the Slack skill still matches every turn).
  triage:
    /\b(triage|nurse|nursing|patient(?:s)?|admit(?:ted|s|ssion)?|acuity|caseload|charge nurse|staffing|assign(?:ment|ed|ing)?|skill[- ]?match|shift)\b/i,
};

/**
 * Classify the intent of a user message given runtime capability flags.
 *
 * @param {string} userMessage
 * @param {{
 *   tableauEnabled?: boolean,
 *   hasUserToken?: boolean,
 *   internetSearch?: boolean,
 * }} caps - capability flags for the current session
 * @param {string} [threadHint] - prior thread text; keeps a Tableau conversation
 *   in Tableau mode on follow-up turns that omit an explicit keyword
 *   (e.g. "you literally showed me OTF Grants Enriched").
 * @returns {{ intents: string[], useFullModel: boolean, wantTableau: boolean }}
 */
function classifyIntent(userMessage, caps = {}, threadHint = "") {
  const intents = new Set();
  // Route to Tableau on an explicit keyword in this message, OR when the thread
  // is already a Tableau conversation (continuity). lexicalWantTableau inspects
  // the combined lexical context — prior datasource names, LUIDs, analytics
  // language — so a keyword-less follow-up doesn't silently lose the context.
  if (
    caps.tableauEnabled &&
    (SIGNAL.tableau.test(userMessage) ||
      (threadHint && lexicalWantTableau(`${userMessage}\n${threadHint}`)))
  ) {
    intents.add(INTENTS.TABLEAU);
  }
  // Canvas fires on an explicit canvas/document request OR a long-form report
  // request — both want a real document. Needs a user token (Canvas API is
  // user-scoped). Falls back gracefully to an in-thread reply when absent.
  if (
    caps.hasUserToken &&
    (SIGNAL.canvas.test(userMessage) || SIGNAL.report.test(userMessage))
  ) {
    intents.add(INTENTS.CANVAS);
  }
  if (SIGNAL.slackSearch.test(userMessage))                    intents.add(INTENTS.SLACK_SEARCH);
  if (caps.internetSearch)                                     intents.add(INTENTS.INTERNET_SEARCH);
  // Triage (nurse-assignment) intent. Needs the Tableau MCP (the specialist
  // reasons over the triage datasources), so gate on tableauEnabled. This intent
  // is only ACTED upon when AGENTS_ENABLED is on and a triage specialist is wired
  // in (supervisor.js); with the flag off it is inert — nothing downstream
  // consumes it, and it is deliberately excluded from useFullModel below so it
  // cannot change model selection on the baseline path.
  if (caps.tableauEnabled && SIGNAL.triage.test(userMessage))  intents.add(INTENTS.TRIAGE);
  if (intents.size === 0)                                      intents.add(INTENTS.CONVERSATIONAL);

  const useFullModel =
    intents.has(INTENTS.TABLEAU) ||
    intents.has(INTENTS.CANVAS) ||
    intents.has(INTENTS.INTERNET_SEARCH);

  const wantTableau = intents.has(INTENTS.TABLEAU);

  return { intents: [...intents], useFullModel, wantTableau };
}

/**
 * Infer wantTableau from a combined user + thread hint text when no pre-computed intent is
 * available (e.g. the tableauContextBuilder calling on its own). This covers follow-up turns
 * where the thread mentions datasource LUIDs or Tableau keywords.
 *
 * @param {string} lexical - concatenation of user message + thread hint
 * @returns {boolean}
 */
function lexicalWantTableau(lexical) {
  if (!lexical || typeof lexical !== "string") return false;
  const t = lexical.toLowerCase();
  return (
    /\btableau\b/.test(t) ||
    /\bvizql\b/.test(t) ||
    /\bdatasource\b/.test(t) ||
    /\bdata source\b/.test(t) ||
    /\bworkbook\b/.test(t) ||
    /\bdashboard\b/.test(t) ||
    (/\bview\b/.test(t) &&
      /\b(published|dashboard|sheet|screenshot|snapshot|thumbnail|image)\b/.test(t)) ||
    /\bhyper\b/.test(t) ||
    /\bextract\b/.test(t) ||
    /\bpulse\b/.test(t) ||
    /\b(hr|personnel|headcount|employees)\b/.test(t) ||
    /\b(summarize|summary|overview)\b.*\b(supply|program|project)\b/i.test(t) ||
    /\b(supply|program)\b.*\b(data|datasource)\b/i.test(t) ||
    /\b(cyber|supply chain|scrm|executive brief|key industries|north america)\b/.test(t) ||
    // Prior thread mentioned a datasource LUID
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t) ||
    // Prior thread used list/analytics language
    /tableau|data\s*source|datasource|published|vizql|pulse|workbook|superstore|list.*source/i.test(t)
  );
}

module.exports = { classifyIntent, lexicalWantTableau, INTENTS, ORIGINS };
