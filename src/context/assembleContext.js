/**
 * Unified context pipeline. Joins the three context blocks produced by
 * getUserLocaleContext, buildSlackContext, and buildTableauContext.
 *
 * Centralises the join so future token-budget prioritisation (e.g. truncate Tableau
 * context when Slack context is very large) has a single place to live.
 */

/**
 * @param {{ localeContext?: string, slackContext?: string, tableauContext?: string }} parts
 * @returns {string}
 */
function assembleContext({ localeContext, slackContext, tableauContext }) {
  return [localeContext, slackContext, tableauContext].filter(Boolean).join("\n");
}

module.exports = { assembleContext };
