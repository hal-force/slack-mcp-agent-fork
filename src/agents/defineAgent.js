/**
 * defineAgent — the multi-agent primitive.
 *
 * A "role-specialized agent" is nothing more than (system prompt + tool set +
 * model tier + output contract). This is a thin wrapper over the EXISTING
 * llmProvider.generateReply() and its Bedrock tool loop — it introduces no new
 * LLM plumbing. See docs/MULTI-AGENT-TRIAGE-DESIGN.md §4.1.
 *
 * The wrapper adds three things on top of generateReply:
 *   1. A role system prompt (prepended to any per-call systemInstruction).
 *   2. Tool wiring passed straight through to the provider's agentic loop.
 *   3. Structured-output extraction: agents are asked to emit a trailing fenced
 *      ```json block; run() parses it into `structured` and leaves the prose in
 *      `text`. Parsing is best-effort — a missing or malformed block yields
 *      structured:null, never throws.
 *
 * A per-agent Bedrock model pin (opts.modelId) is threaded via a NEW request key
 * `bedrockModelId` that no existing caller sets, so it cannot perturb the
 * baseline path. It is deliberately distinct from generateReply's Gemini-only
 * `opts.modelId` (a Bedrock model id must never leak into a Gemini call, or vice
 * versa).
 */

const { generateReply } = require("../assistant/llmProvider");

/**
 * Extract a trailing (or embedded) fenced ```json code block and parse it.
 * Returns { structured, cleanedText } — cleanedText has the block removed so the
 * Slack-facing prose isn't cluttered with raw JSON. Never throws.
 *
 * @param {string} text
 * @returns {{ structured: object|null, cleanedText: string }}
 */
function extractStructured(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return { structured: null, cleanedText: raw };

  // Match ```json … ``` (case-insensitive lang tag; also bare ``` with a JSON
  // body). Prefer the LAST such block — agents are prompted to put structured
  // output at the end, after the prose.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  let last = null;
  while ((match = fenceRe.exec(raw)) !== null) {
    const body = (match[1] || "").trim();
    if (body.startsWith("{") || body.startsWith("[")) {
      last = { body, index: match.index, full: match[0] };
    }
  }

  // Recovery for a TRUNCATED response: the model is prompted to put the JSON
  // block last, so a max_tokens cutoff often severs the closing ``` (and leaves
  // a complete-enough body). The closed-fence regex above misses that entirely,
  // silently dropping structured output. If no closed block matched, look for a
  // trailing UNTERMINATED fence and try its body — strictly additive, since any
  // properly-closed block was already captured.
  if (!last) {
    const openRe = /```(?:json)?\s*([\s\S]*)$/i;
    const open = openRe.exec(raw);
    if (open) {
      const body = (open[1] || "").trim();
      if (body.startsWith("{") || body.startsWith("[")) {
        last = { body, index: open.index, full: open[0] };
      }
    }
  }
  if (!last) return { structured: null, cleanedText: raw };

  let structured = null;
  try {
    structured = JSON.parse(last.body);
  } catch (_) {
    // Malformed JSON block: leave structured null but still strip nothing — the
    // caller may want to see the attempted block in the prose for debugging.
    return { structured: null, cleanedText: raw };
  }
  const cleanedText = (raw.slice(0, last.index) + raw.slice(last.index + last.full.length)).trim();
  return { structured, cleanedText };
}

/**
 * Define a role-specialized agent.
 *
 * @param {object} spec
 * @param {string} spec.name                       - role id (for logs/labels)
 * @param {string} spec.systemPrompt               - role system prompt
 * @param {Array<object>} [spec.tools]             - provider-neutral tool specs
 * @param {(name:string, input:object)=>Promise<object>} [spec.dispatchTool]
 * @param {string} [spec.modelId]                  - Bedrock model pin (optional)
 * @param {number} [spec.maxOutputTokens]
 * @param {number} [spec.temperature]
 * @param {boolean} [spec.parseStructured=true]    - extract trailing ```json block
 * @returns {{ name: string, run: (input: object) => Promise<object> }}
 */
function defineAgent(spec = {}) {
  const {
    name = "agent",
    systemPrompt = "",
    tools,
    dispatchTool,
    modelId,
    maxOutputTokens,
    temperature,
    parseStructured = true,
  } = spec;

  /**
   * @param {object} input
   * @param {Array<{role:string, parts:[{text:string}]}>} input.contents
   *   Provider-neutral contents (same shape respond.buildContents produces).
   * @param {string} [input.systemInstructionExtra] - appended to the role prompt
   * @param {boolean} [input.googleSearchActive]
   * @returns {Promise<{ name:string, text:string, structured:object|null, raw:object }>}
   */
  async function run(input = {}) {
    const {
      contents = [],
      systemInstructionExtra = "",
      googleSearchActive = false,
    } = input;

    const systemInstruction = [systemPrompt, systemInstructionExtra]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join("\n\n");

    const req = {
      systemInstruction,
      contents,
      maxOutputTokens: Number(maxOutputTokens) || undefined,
      temperature,
      googleSearchActive,
      ...(tools ? { tools } : {}),
      ...(typeof dispatchTool === "function" ? { dispatchTool } : {}),
      // NEW key: a Bedrock-only model pin. generateReply/generateWithBedrock read
      // this to override cfg.model for this agent WITHOUT affecting other callers
      // (nothing else sets it). Distinct from the Gemini `opts.modelId` path.
      ...(modelId ? { bedrockModelId: modelId } : {}),
    };

    const result = await generateReply(req);
    const text = result.text || "";

    if (!parseStructured) {
      return { name, text, structured: null, raw: result };
    }
    const { structured, cleanedText } = extractStructured(text);
    return { name, text: cleanedText || text, structured, raw: result };
  }

  return { name, run };
}

module.exports = { defineAgent, extractStructured };
