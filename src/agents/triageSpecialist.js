/**
 * triageSpecialist — the first role-specialized agent (design §4.3).
 *
 * A defineAgent() instance: (role prompt + triage tools + model pin + structured
 * output contract). It answers two kinds of question over the synthetic hospital
 * dataset, reached through triageTools (local CSV backend now; Tableau MCP at M4):
 *
 *   - analysis:       "Does skill match predict adverse outcomes? Control for
 *                      acuity." / "Compare AI-recommended vs manual skill match."
 *   - recommendation: "PT#### was just admitted — which nurse should take them?"
 *
 * ── What the prompt does and does NOT contain ─────────────────────────────
 * The role prompt carries METHODOLOGY (control for confounders, don't over-read
 * small subgroups, don't cite derived/validation columns, don't fan out the skill
 * bridges) — the standing rules of a competent operations analyst. It carries NO
 * knowledge of which relationships are planted, at what magnitude, or which
 * plausible factors are null: the specialist must DISCOVER those from the data.
 * Leaking any of that would make the eval (tests/eval/triage) meaningless.
 *
 * Model: pinned via AGENT_TRIAGE_MODEL_ID for reproducible eval scores (falls back
 * to the app's BEDROCK_MODEL_ID when unset). Tools are Bedrock-shaped, so the
 * specialist runs on the Bedrock provider.
 */

const { defineAgent } = require("./defineAgent");
const { TRIAGE_TOOL_SPECS, dispatchTriageTool } = require("./triageTools");
const { buildContents } = require("../assistant/respond");
const { defaultMaxOutputTokens } = require("../assistant/llmProvider");

/**
 * Choose the tool backend. Default is the local-CSV dispatcher (deterministic, offline —
 * what the eval and every test rely on). When TRIAGE_MCP_DATASOURCES is set (a JSON
 * table→datasourceLuid map from the M4 publish), the SAME tools run against the published
 * Tableau datasources via the MCP instead — the specialist prompt and tool specs are
 * identical either way. An explicit opts.dispatchTool always wins (tests / callers).
 * @param {object} opts
 * @returns {(name:string, input:object)=>Promise<object>}
 */
function resolveDispatchTool(opts = {}) {
  if (typeof opts.dispatchTool === "function") return opts.dispatchTool;
  const dsRaw = String(process.env.TRIAGE_MCP_DATASOURCES || "").trim();
  if (dsRaw) {
    const { makeMcpDispatchTool } = require("./triageMcpData");
    return makeMcpDispatchTool();
  }
  return (name, input) => dispatchTriageTool(name, input);
}

const TRIAGE_SYSTEM_PROMPT = `Role: You are the Nurse-Triage Specialist, a clinical-operations analyst for an AI-assisted nurse assignment program. All data is SYNTHETIC. Your output is advisory and human-in-the-loop — you never take clinical action.

You answer two kinds of question about one hospital's data, which you reach ONLY through your tools (triage_query, triage_skill_gap, triage_list_nurses_on_shift):

1. ANALYSIS — operational questions about the data: whether assignment strategy or skill match relates to outcomes, where the staffing risk and skill gaps are. These must be answered with numbers you pulled, not assumptions.
2. RECOMMENDATION — for a newly admitted patient, which on-shift nurse should take them, justified by skill fit and current workload, with the effect on the unit's risk profile.

THE DATA (all via tools):
- patients (one per admission): acuity_level (Critical/Severe/Moderate/Low), acuity_score, comorbidity ("None" or a condition), diagnosis, age, sex, los_hours, outcome, adverse_outcome (0/1).
- nurses: home_unit, shift_pattern, experience_years, certification, max_caseload, skill_count.
- assignments (one per nurse×patient×shift): assignment_method (AI-Recommended | Manual), skill_match_pct, workload_score, caseload_at_assignment.
- nurse_skills / patient_required_skills: the two skill bridges. skills_reference: the taxonomy.
- unit_snapshots: hourly unit census/occupancy/ratio/risk.
- clinical_notes: free-text H&P/progress/discharge for some patients — detail that exists in NO structured column.

METHODOLOGY (mandatory — this is how you avoid confabulation):
- Pull before you claim. Every quantitative statement must trace to a triage_query result you actually ran. Show the comparison (the groups and their rates/means).
- Control for confounders. Before attributing an outcome difference to a factor, re-run the comparison grouped by plausible confounders (patient severity is the usual clinical one) and check the pattern holds within groups. A raw difference that vanishes (or reverses) under the control is confounded — say so.
- Distinguish derived from observed. skill_match_pct and workload_score are computed from the skill bridges and caseload. patients.mean_skill_match_pct is a validation aid and is deliberately unavailable to you — analyze patient-level skill match with the derived column patient_mean_skill_match / skill_match_bucket in triage_query (computed honestly from assignments), never by asserting a column that is its own input.
- Never fan out. Do not ask for the skill bridges joined into patients or assignments — it multiplies rows and inflates aggregates. Use triage_skill_gap for skill coverage.
- Respect sample size. Subgroup cells can be small (some n < 20). Caveat any claim resting on a small cell, and flag when a subgroup runs counter to the overall pattern rather than hiding it.
- Report the null. If a plausible-sounding factor shows no real relationship once you test it, SAY so explicitly — "tested, no effect" is a finding, not something to omit. Do not report a relationship you could not demonstrate.

SLACK FORMATTING:
- No markdown headers (#). Use *bold* for emphasis and BOLD ALL CAPS for section titles. Bullets with -, blank lines between sections. Never use pipe tables. Links as <URL|text>.

OUTPUT CONTRACT (mandatory):
Write your human-facing answer as Slack prose FIRST. Then, as the LAST thing in your message, emit a single fenced json block (\`\`\`json … \`\`\`) with this shape:

{
  "mode": "analysis" | "recommendation",
  "findings": [                         // analysis mode: one per relationship you actually tested
    {
      "effect": "<short snake_case key naming the relationship, e.g. <factor>_to_<outcome>>",
      "claim": "<one sentence, plain>",
      "magnitude": { "<label>": <number>, ... },   // the numbers YOU pulled from the data, keyed by group label (e.g. {"group_a": <n>, "group_b": <n>})
      "controlled_for": ["<confounder>", ...],      // confounders you actually controlled for ([] if none)
      "confidence": "high" | "medium" | "low",
      "caveats": ["<e.g. a subgroup cell with small n; a subgroup that runs counter>"]
    }
  ],
  "declined": ["<factor you TESTED and found no real effect>"],
  "recommendation": {                   // recommendation mode only
    "patient_id": "PT####",
    "ranked_nurses": [
      { "nurse_id": "RN###", "skill_match_pct": <n>, "current_caseload": <n>, "missing_skills": ["SK##"], "rationale": "<why>" }
    ],
    "unit_risk_note": "<how this assignment changes the unit's risk profile>"
  }
}

Only include the keys relevant to the mode. The json is parsed by tooling — keep it valid. Your prose and the json must agree.`;

// The per-call model pin. Reproducible eval wants a fixed model; when unset the
// agent inherits the app's BEDROCK_MODEL_ID (defineAgent passes no override).
function triageModelId() {
  return String(process.env.AGENT_TRIAGE_MODEL_ID || "").trim() || undefined;
}

/**
 * Build the triage specialist. Returns { name, run } where run() accepts the
 * supervisor's { aiParams, intents } envelope (aiParams is the same object that
 * would have gone to getAiResponse), assembles provider-neutral contents from it
 * (reusing respond.buildContents so thread content from other participants stays
 * fenced as untrusted data), and invokes the underlying defineAgent instance.
 *
 * @param {object} [opts]
 * @param {(name:string, input:object)=>Promise<object>} [opts.dispatchTool]
 *   Force a specific tool backend (tests). When unset, the backend is chosen by
 *   resolveDispatchTool: Tableau MCP if TRIAGE_MCP_DATASOURCES is set, else local CSV.
 * @param {string} [opts.modelId]  Override the model pin (tests).
 * @param {number} [opts.maxOutputTokens]
 * @returns {{ name: string, run: (envelope:object)=>Promise<object> }}
 */
function createTriageSpecialist(opts = {}) {
  const agent = defineAgent({
    name: "triage-specialist",
    systemPrompt: TRIAGE_SYSTEM_PROMPT,
    tools: TRIAGE_TOOL_SPECS,
    dispatchTool: resolveDispatchTool(opts),
    modelId: opts.modelId || triageModelId(),
    maxOutputTokens: Number(opts.maxOutputTokens) || defaultMaxOutputTokens(),
    // Sonnet 5 rejects the temperature param; llmProvider strips it on demand, but
    // leaving it unset avoids the retry round-trip for the pinned model.
    parseStructured: true,
  });

  async function run(envelope = {}) {
    const { aiParams = {} } = envelope;
    const { userMessage = "", threadHistory = [], skillContext = "" } = aiParams;
    const contents = buildContents(threadHistory || [], String(userMessage || "").trim(), skillContext || "");
    if (contents.length === 0) {
      return { name: "triage-specialist", text: "", structured: null, raw: null };
    }
    return agent.run({ contents });
  }

  return { name: "triage-specialist", run };
}

module.exports = { createTriageSpecialist, TRIAGE_SYSTEM_PROMPT, triageModelId, resolveDispatchTool };
