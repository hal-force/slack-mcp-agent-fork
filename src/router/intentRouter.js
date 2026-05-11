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
  CONVERSATIONAL:  "conversational",
};

const ORIGINS = {
  DM_ASSISTANT:    "dm_assistant",
  CHANNEL_MENTION: "channel_mention",
  WORKFLOW:        "workflow",
};

const SIGNAL = {
  tableau:
    /\btableau\b|\bvizql\b|\bdatasource\b|\bdata source\b|\bworkbook\b|\bdashboard\b|\bpulse\b/i,
  canvas:
    /\bcanvas\b|\bcreate\b.*\bdoc(?:ument)?\b|\bdoc(?:ument)?\b.*\bcreate\b/i,
  slackSearch:
    /\bfind\b|\bsearch\b|\bwho (?:said|mentioned|posted)\b|\bshow me messages\b/i,
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
 * @returns {{ intents: string[], useFullModel: boolean, wantTableau: boolean }}
 */
function classifyIntent(userMessage, caps = {}) {
  const intents = new Set();
  if (caps.tableauEnabled && SIGNAL.tableau.test(userMessage)) intents.add(INTENTS.TABLEAU);
  if (caps.hasUserToken   && SIGNAL.canvas.test(userMessage))  intents.add(INTENTS.CANVAS);
  if (SIGNAL.slackSearch.test(userMessage))                    intents.add(INTENTS.SLACK_SEARCH);
  if (caps.internetSearch)                                     intents.add(INTENTS.INTERNET_SEARCH);
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
