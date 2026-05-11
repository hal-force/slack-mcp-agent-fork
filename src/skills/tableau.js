/**
 * Tableau skill — wraps TABLEAU_FUNCTION_DECLARATIONS + dispatchTableauTool.
 */

const {
  TABLEAU_FUNCTION_DECLARATIONS,
  isTableauGeminiTool,
  dispatchTableauTool,
  tableauQueryToolsEnabled,
} = require("../assistant/tableauGeminiTools");

/**
 * Create a Tableau skill instance bound to session-specific opts.
 * @param {{ tableauMcpBaseUrl?: string }} sessionOpts
 * @returns {{ name: string, functionDeclarations: object[], handlesToolName: (n: string) => boolean, dispatch: Function, isAvailable: (caps: object) => boolean }}
 */
function createTableauSkill({ tableauMcpBaseUrl }) {
  return {
    name: "tableau",
    functionDeclarations: TABLEAU_FUNCTION_DECLARATIONS,
    handlesToolName: isTableauGeminiTool,
    dispatch: (name, args, sessionOpts) =>
      dispatchTableauTool(name, args, {
        tableauMcpBaseUrl,
        uploadQueue: sessionOpts?.uploadQueue,
        datasourceUrlByLuid: sessionOpts?.datasourceUrlByLuid,
        viewUrlById: sessionOpts?.viewUrlById,
      }),
    isAvailable: () => tableauQueryToolsEnabled({ tableauMcpBaseUrl }),
  };
}

module.exports = { createTableauSkill };
