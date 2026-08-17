/**
 * Convert a Slack mrkdwn string into Block Kit blocks for chat.postMessage / say().
 * Strategy A: server-side chunking — no model schema change.
 *
 * Limits: https://api.slack.com/reference/block-kit/blocks
 * - Max 50 blocks per message
 * - mrkdwn text objects: 3000 chars max
 */

const MAX_BLOCKS = 50;
const MAX_MRKDWN_CHARS = 3000;
const MAX_FALLBACK_CHARS = 3000;
const HEADER_MAX_PLAIN = 150;

/**
 * @param {string} raw
 * @returns {string}
 */
function stripMrkdwnForPlain(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^\*([^*]+)\*$/s, "$1");
  s = s.replace(/^_([^_]+)_$/s, "$1");
  s = s.replace(/^~([^~]+)~$/s, "$1");
  return s.replace(/<[^|>]+\|([^>]+)>/g, "$1").replace(/<(@[A-Z0-9]+|#[A-Z0-9]+|!subteam[^>]+)>/gi, "");
}

/**
 * First paragraph or up to MAX_FALLBACK_CHARS for notifications / thread history.
 * @param {string} mrkdwn
 * @returns {string}
 */
function buildFallbackText(mrkdwn) {
  const t = String(mrkdwn || "").trim();
  if (!t) return "";
  const paraBreak = t.search(/\n\s*\n/);
  let out = paraBreak === -1 ? t : t.slice(0, paraBreak).trim();
  if (out.length > MAX_FALLBACK_CHARS) {
    out = out.slice(0, MAX_FALLBACK_CHARS - 1) + "…";
  }
  return out;
}

/**
 * Split a string into pieces of at most maxLen, preferring line breaks.
 * @param {string} s
 * @param {number} maxLen
 * @returns {string[]}
 */
function chunkByMaxLen(s, maxLen) {
  if (s.length <= maxLen) return s ? [s] : [];
  const parts = [];
  let rest = s;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      parts.push(rest);
      break;
    }
    let slice = rest.slice(0, maxLen);
    const nl = slice.lastIndexOf("\n");
    if (nl > maxLen * 0.5) {
      slice = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
    } else {
      rest = rest.slice(maxLen);
    }
    if (slice) parts.push(slice);
  }
  return parts;
}

/**
 * True if this single-line segment can use a header block (plain_text ≤150).
 * @param {string} segment
 * @returns {boolean}
 */
function looksLikeHeaderLine(segment) {
  const line = segment.trim();
  if (!line || line.includes("\n")) return false;
  const plain = stripMrkdwnForPlain(line);
  if (plain.length === 0 || plain.length > HEADER_MAX_PLAIN) return false;
  const letters = plain.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 3) return false;
  const upperRatio = letters.replace(/[^A-Z]/g, "").length / letters.length;
  return upperRatio >= 0.7;
}

/**
 * @param {string} mrkdwn
 * @returns {{ type: 'section', text: { type: 'mrkdwn', text: string } }}
 */
function sectionMrkdwn(mrkdwn) {
  return {
    type: "section",
    text: { type: "mrkdwn", text: mrkdwn },
  };
}

/**
 * @param {string} plain
 * @returns {{ type: 'header', text: { type: 'plain_text', text: string, emoji: boolean } }}
 */
function headerBlock(plain) {
  const t = plain.length > HEADER_MAX_PLAIN ? plain.slice(0, HEADER_MAX_PLAIN - 1) + "…" : plain;
  return {
    type: "header",
    text: { type: "plain_text", text: t, emoji: true },
  };
}

/**
 * Convert assistant mrkdwn output to Block Kit blocks plus fallback text.
 * @param {string} mrkdwn
 * @returns {{ text: string, blocks: object[] }}
 */
function mrkdwnStringToBlocks(mrkdwn) {
  const full = String(mrkdwn || "").trim();
  const fallback = buildFallbackText(full) || " ";
  if (!full) {
    return { text: " ", blocks: [sectionMrkdwn("_Empty response_")] };
  }

  /** @type {object[]} */
  const blocks = [];
  let segments = full.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

  if (segments.length === 0) {
    segments = [full];
  }

  let useFirstAsHeader = false;
  if (segments.length > 1 && looksLikeHeaderLine(segments[0])) {
    useFirstAsHeader = true;
  } else if (segments.length === 1) {
    const only = segments[0];
    const firstNl = only.indexOf("\n");
    if (firstNl > 0) {
      const firstLine = only.slice(0, firstNl).trim();
      const rest = only.slice(firstNl + 1).trim();
      if (rest && looksLikeHeaderLine(firstLine)) {
        segments = [firstLine, rest];
        useFirstAsHeader = true;
      }
    }
  }

  // Build blocks UNBOUNDED here — do not cap at MAX_BLOCKS during construction.
  // A previous version hard-stopped here, which silently dropped every segment
  // past the 50-block ceiling (and since segments break at section titles, the
  // cut always landed on a heading). collapseBlocksIfNeeded() below is what fits
  // the result into Slack's limit, packing text instead of discarding it.
  function pushBlock(block) {
    blocks.push(block);
    return true;
  }

  let segStart = 0;
  if (useFirstAsHeader) {
    const plain = stripMrkdwnForPlain(segments[0]);
    if (plain) {
      pushBlock(headerBlock(plain));
      segStart = 1;
    }
  }

  for (let i = segStart; i < segments.length; i++) {
    if (i > segStart) {
      pushBlock({ type: "divider" });
    }
    const chunks = chunkByMaxLen(segments[i], MAX_MRKDWN_CHARS);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      pushBlock(sectionMrkdwn(chunk));
    }
  }

  if (blocks.length === 0) {
    chunkByMaxLen(full, MAX_MRKDWN_CHARS).forEach((c) => {
      if (c.trim()) blocks.push(sectionMrkdwn(c));
    });
  }

  const collapsed = collapseBlocksIfNeeded(blocks);

  if (collapsed.length === 0) {
    return { text: fallback, blocks: [sectionMrkdwn(full.slice(0, MAX_MRKDWN_CHARS))] };
  }

  return { text: fallback, blocks: collapsed };
}

/**
 * Count lines that look like BOLD ALL CAPS section titles — used to report how
 * many sections were omitted when a report genuinely overflows the block budget.
 * @param {string} text
 * @returns {number}
 */
function countHeadingLines(text) {
  let n = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (looksLikeHeaderLine(line)) n++;
  }
  return n;
}

/**
 * Fit blocks into Slack's 50-block limit WITHOUT silently dropping content.
 * Drops the cosmetic dividers (they otherwise burn ~half the block budget) and
 * densely packs the section text into as few section blocks as possible. Only
 * when the packed text still overflows (~150KB) do we truncate — and then we
 * keep as much as fits and append a VISIBLE indicator with the count of omitted
 * sections, never a silent cut.
 * @param {object[]} blocks
 * @returns {object[]}
 */
function collapseBlocksIfNeeded(blocks) {
  if (blocks.length <= MAX_BLOCKS) return blocks;
  const header = blocks[0]?.type === "header" ? blocks[0] : null;
  const sliceFrom = header ? 1 : 0;
  const parts = [];
  for (let i = sliceFrom; i < blocks.length; i++) {
    const b = blocks[i];
    // Dividers are intentionally dropped here — they are cosmetic and each one
    // consumes a block slot that content needs when we're over the limit.
    if (b.type === "section" && b.text?.type === "mrkdwn" && b.text.text) {
      parts.push(b.text.text);
    }
  }
  const joined = parts.join("\n\n");
  const maxSections = MAX_BLOCKS - (header ? 1 : 0);
  const chunks = chunkByMaxLen(joined, MAX_MRKDWN_CHARS);

  const out = [];
  if (header) out.push(header);

  if (chunks.length <= maxSections) {
    // Everything fits once dividers are dropped and text is packed — no loss.
    for (const c of chunks) {
      if (c.trim()) out.push(sectionMrkdwn(c));
    }
    return out.length > 0 ? out : [sectionMrkdwn(joined.slice(0, MAX_MRKDWN_CHARS))];
  }

  // Genuine overflow: reserve the final block for a visible truncation notice so
  // the user knows the reply was cut (and can ask to continue / open the canvas).
  const kept = chunks.slice(0, maxSections - 1);
  const omitted = chunks.slice(maxSections - 1).join("\n\n");
  for (const c of kept) {
    if (c.trim()) out.push(sectionMrkdwn(c));
  }
  const omittedSections = countHeadingLines(omitted);
  const note =
    omittedSections > 0
      ? `_…(message truncated — ${omittedSections} more ${omittedSections === 1 ? "section" : "sections"} omitted; ask me to continue or open the canvas for the full report.)_`
      : "_…(message truncated — the rest was omitted; ask me to continue or open the canvas for the full report.)_";
  out.push(sectionMrkdwn(note));
  return out;
}

module.exports = {
  mrkdwnStringToBlocks,
  buildFallbackText,
  MAX_BLOCKS,
  MAX_MRKDWN_CHARS,
};
