/**
 * Generate a title for a Slack canvas.
 *
 * A canvas's title is its first section — a leading `# H1` in the document
 * markdown. We can't rely on the `title` arg to canvases.create because the body
 * is written afterward with a full-document `replace`, which resets the first
 * section. So the title is prepended as an H1 to the canvas markdown at write
 * time (see respond.js dispatchSideEffects) — canvas-only, never in the Slack
 * message copy (which uses Slack mrkdwn and forbids `#` headers).
 *
 * The title text is produced by a tiny LLM call over the report content (best
 * signal), with a deterministic heuristic fallback derived from the user's
 * request so a canvas is never left untitled if the model call fails.
 */

const { generateReply } = require("../assistant/llmProvider");

/**
 * Sanitize a raw model/heuristic title into a single clean canvas title line.
 * Strips markdown, surrounding quotes, leading heading markers, and trailing
 * punctuation; collapses whitespace; caps length (canvas title max 255 bytes).
 *
 * @param {unknown} raw
 * @returns {string}
 */
function cleanTitle(raw) {
  if (raw == null) return "";
  let t = String(raw);
  // First non-empty line only — models sometimes add a preamble or trailing note.
  t = (t.split(/\r?\n/).map((l) => l.trim()).find((l) => l) || "").trim();
  t = t.replace(/^#{1,6}\s*/, ""); // leading markdown heading marker
  t = t.replace(/^["'“”‘’*_`]+|["'“”‘’*_`]+$/g, ""); // wrapping quotes/emphasis
  t = t.replace(/[*_`~]/g, ""); // stray inline markdown
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/[.,;:!?\s]+$/g, ""); // trailing punctuation
  if (t.length > 120) t = t.slice(0, 120).replace(/\s+\S*$/, "").trim();
  return t;
}

/**
 * Deterministic fallback title from free text (usually the user's request).
 * Title-cases the first handful of meaningful words. Never throws.
 *
 * @param {string} text
 * @returns {string}
 */
function deriveTitleFromText(text) {
  const base = cleanTitle((text || "").replace(/^(please|can you|could you|hey|hi|prism)\b[,:]?\s*/i, ""));
  if (!base) return "Untitled Canvas";
  const words = base.split(" ").filter(Boolean).slice(0, 8);
  const titled = words
    .map((w) => (/^[a-z]/.test(w) && w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
  return titled || "Untitled Canvas";
}

/**
 * Produce a short canvas title. Best-effort LLM call over the report content,
 * with a heuristic fallback from the user message. Never throws.
 *
 * @param {string} sourceText - the canvas body / report content (best signal)
 * @param {{ userMessage?: string }} [opts]
 * @returns {Promise<string>}
 */
async function generateCanvasTitle(sourceText, opts = {}) {
  const fallback = deriveTitleFromText(opts.userMessage || sourceText || "");
  const basis = String(sourceText || opts.userMessage || "").slice(0, 4000);
  if (!basis.trim()) return fallback;
  try {
    const result = await generateReply(
      {
        systemInstruction:
          "You write a concise, specific title for a document. Output ONLY the title text: 3 to 8 words, Title Case, no surrounding quotes, no trailing punctuation, no markdown, no line breaks. Base it on the document's actual subject.",
        contents: [{ role: "user", parts: [{ text: `Document:\n${basis}\n\nTitle:` }] }],
        maxOutputTokens: 24,
        temperature: 0.3,
      },
      {},
    );
    return cleanTitle(result && result.text) || fallback;
  } catch {
    return fallback;
  }
}

module.exports = { generateCanvasTitle, cleanTitle, deriveTitleFromText };
