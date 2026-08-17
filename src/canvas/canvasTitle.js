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
 * The title is derived deterministically — no LLM call. It was previously a
 * dedicated model round-trip, but (a) the report the model just produced already
 * carries the subject, and (b) that call passed no modelId so it always threw on
 * the Vertex backend and fell back to this heuristic anyway. Deriving from the
 * user's own phrasing (normal case, so acronyms like "OTF" are preserved) — with
 * the report's first strong line as backup — gives an equivalent title for free
 * and off the critical path.
 */

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

// Generic section headings that make poor canvas titles — if the report's first
// strong line is one of these, keep scanning for a more specific one.
const GENERIC_HEADINGS = new Set([
  "executive summary",
  "summary",
  "overview",
  "introduction",
  "background",
  "report",
  "analysis",
]);

/**
 * Derive a title from the report body: the first specific `BOLD ALL CAPS` /
 * heading-like line (skipping generic ones like "EXECUTIVE SUMMARY"), else the
 * first non-empty line. Used only when there's no usable user request to title
 * from. Never throws.
 *
 * A matched ALL-CAPS heading is kept verbatim — you can't reliably recover
 * acronym casing from an all-caps string (e.g. "OTF" has a vowel, "FUND" is
 * short), so title-casing it would corrupt acronyms; an all-caps canvas title is
 * acceptable for this rare fallback. A non-caps first line is title-cased.
 *
 * @param {string} text
 * @returns {string}
 */
function deriveTitleFromReportText(text) {
  const lines = String(text || "").split(/\r?\n/);
  let firstNonEmpty = "";
  for (const raw of lines) {
    const cleaned = cleanTitle(raw);
    if (!cleaned) continue;
    if (!firstNonEmpty) firstNonEmpty = cleaned;
    // Prefer an ALL-CAPS-ish section title that isn't generic.
    const letters = cleaned.replace(/[^a-zA-Z]/g, "");
    const isUpper =
      letters.length >= 3 &&
      letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.7;
    if (isUpper && !GENERIC_HEADINGS.has(cleaned.toLowerCase())) {
      return cleaned; // keep verbatim — preserves acronyms
    }
  }
  if (!firstNonEmpty) return "Untitled Canvas";
  // A non-ALL-CAPS first line: title-case its leading words like a user request.
  return deriveTitleFromText(firstNonEmpty);
}

/**
 * Produce a short canvas title, derived deterministically (no LLM call).
 * Prefers the user's own request phrasing (so acronyms they typed — "OTF" — are
 * preserved), falling back to the report body's first specific heading. Never
 * throws. Kept async so callers need no change if a model-based path returns.
 *
 * @param {string} sourceText - the canvas body / report content
 * @param {{ userMessage?: string }} [opts]
 * @returns {Promise<string>}
 */
async function generateCanvasTitle(sourceText, opts = {}) {
  const fromUser = deriveTitleFromText(opts.userMessage || "");
  if (fromUser && fromUser !== "Untitled Canvas") return fromUser;
  const fromReport = deriveTitleFromReportText(sourceText || "");
  if (fromReport && fromReport !== "Untitled Canvas") return fromReport;
  return "Untitled Canvas";
}

/**
 * Prepend a title to canvas markdown as a leading `# H1` (the canvas's first
 * section = its title). No-ops when there's no title, or when the body already
 * starts with an H1 (so we never double-title). Pure and deterministic.
 *
 * @param {string} markdown - the canvas body markdown
 * @param {string} title - the title to set (falsy → body unchanged)
 * @returns {string}
 */
function titledCanvasMarkdown(markdown, title) {
  const body = markdown || "";
  if (!title) return body;
  if (/^\s*#\s/.test(body)) return body; // already has a leading H1 title
  return `# ${title}\n\n${body}`;
}

module.exports = {
  generateCanvasTitle,
  cleanTitle,
  deriveTitleFromText,
  deriveTitleFromReportText,
  titledCanvasMarkdown,
};
