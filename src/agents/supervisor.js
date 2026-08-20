/**
 * Supervisor — the coordination layer above the single reasoning call.
 *
 * For the first vertical slice (docs/MULTI-AGENT-TRIAGE-DESIGN.md §4.2) this is
 * deliberately minimal:
 *
 *   - AGENTS_ENABLED off (default)  → delegate to getAiResponse() unchanged.
 *     This is byte-for-byte today's behavior; the supervisor is a pass-through.
 *   - AGENTS_ENABLED on + TRIAGE intent + a triage specialist wired in
 *                                    → run the specialist as a deterministic
 *     sub-call and compose its result into the reply shape getAiResponse returns.
 *   - AGENTS_ENABLED on + anything else
 *                                    → delegate to getAiResponse() (baseline).
 *
 * The supervisor never fans out to multiple specialists yet (that's a later
 * slice). Coupling is a sub-call, not agent-to-agent messaging — deterministic
 * and unit-testable.
 *
 * Dependencies (getAiResponse, the triage specialist runner) are INJECTED rather
 * than required here, to keep the module free of the respond.js → llmProvider
 * chain at load time and to make the flag/branch logic trivially testable.
 */

const { INTENTS } = require("../router/intentRouter");

function agentsEnabled() {
  const v = String(process.env.AGENTS_ENABLED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * @param {object} params
 * @param {string[]} [params.intents]        - from classifyIntent()
 * @param {object} params.aiParams           - the exact args object destined for getAiResponse()
 * @param {object} deps
 * @param {(args:object)=>Promise<object>} deps.getAiResponse
 * @param {{ run: (input:object)=>Promise<object> }|null} [deps.triageSpecialist]
 *   When present AND flag on AND intent is TRIAGE, the specialist handles the turn.
 * @param {(specResult:object, aiParams:object)=>Promise<object>|object} [deps.composeTriageReply]
 *   Turns the specialist's structured/prose result into the { text, uploads,
 *   runSideEffects } shape the caller expects. Required if triageSpecialist is set.
 * @returns {Promise<object>} the getAiResponse-shaped reply
 */
async function runSupervised(params, deps) {
  const { intents = [], aiParams } = params || {};
  const { getAiResponse, triageSpecialist = null, composeTriageReply = null } = deps || {};

  if (typeof getAiResponse !== "function") {
    throw new Error("runSupervised: deps.getAiResponse is required");
  }

  // Flag off → exact baseline. No specialist, no branch, no arg mutation.
  if (!agentsEnabled()) {
    return getAiResponse(aiParams);
  }

  const isTriage = Array.isArray(intents) && intents.includes(INTENTS.TRIAGE);
  if (isTriage && triageSpecialist && typeof triageSpecialist.run === "function") {
    if (typeof composeTriageReply !== "function") {
      throw new Error("runSupervised: composeTriageReply is required when triageSpecialist is set");
    }
    try {
      const specResult = await triageSpecialist.run({ aiParams, intents });
      return await composeTriageReply(specResult, aiParams);
    } catch (err) {
      // A specialist failure must never black-hole the user's turn — fall back to
      // the baseline path so they still get an answer.
      if (process.env.NODE_ENV !== "production") {
        console.error("[supervisor] triage specialist error, falling back:", err?.message || err);
      }
      return getAiResponse(aiParams);
    }
  }

  // Flag on but no specialist applies → baseline.
  return getAiResponse(aiParams);
}

module.exports = { runSupervised, agentsEnabled };
