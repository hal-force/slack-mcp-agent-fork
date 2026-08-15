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
  // Tableau is the agent's primary analytics surface, so route data-shaped
  // questions here even when the user never says "Tableau" — e.g. "find my
  // grants data", "show me the sales numbers". Fetching the datasource catalog
  // is cheap; the skill no-ops if nothing matches. slack_search may also fire
  // on the same turn — both skills contribute context in parallel.
  tableau:
    /\btableau\b|\bvizql\b|\bdatasources?\b|\bdata\s?sources?\b|\bworkbooks?\b|\bdashboards?\b|\bpulse\b|\bdatasets?\b|\bgrants?\b|\bmetrics?\b|\bkpis?\b|\banalytics\b|\breports?\b|\bfigures\b|\bnumbers\b|\bstatistics\b|\bstats\b|\bdata\b/i,
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
