const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  mrkdwnStringToBlocks,
  MAX_BLOCKS,
  MAX_MRKDWN_CHARS,
} = require("../src/slack/mrkdwnToBlocks");

const para = () =>
  "This paragraph interprets the data and explains what it means for stakeholders, including trends, drivers, comparisons, outliers, and caveats worth noting.";

const REPORT_TITLES = [
  "EXECUTIVE SUMMARY",
  "FUNDING OVERVIEW",
  "GRANTS BY PROGRAM AREA",
  "TOP RECIPIENT ORGANIZATIONS",
  "GEOGRAPHIC DISTRIBUTION",
  "TRENDS OVER TIME",
  "YOUTH OPPORTUNITIES FUND",
  "DATA QUALITY NOTES",
  "GRANT STATUS BREAKDOWN",
  "YEAR OVER YEAR GROWTH",
  "SECTOR ANALYSIS",
  "EQUITY CONSIDERATIONS",
  "RECOMMENDATIONS",
  "METHODOLOGY",
  "CAVEATS AND LIMITATIONS",
  "NEXT STEPS",
];

/** Concatenated mrkdwn text of every section block (ignores dividers/headers). */
function bodyText(blocks) {
  return blocks
    .map((b) => (b.text && typeof b.text.text === "string" ? b.text.text : ""))
    .join("\n");
}

test("short message keeps its section/divider/section layout", () => {
  const { blocks } = mrkdwnStringToBlocks(
    "*SUMMARY*\nHere is a quick answer.\n\n*DETAIL*\nA second short section.",
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["section", "divider", "section"],
  );
});

test("never exceeds Slack's 50-block ceiling", () => {
  const report = REPORT_TITLES.map(
    (t) => `*${t}*\n${para()} ${para()}\n\n${para()} ${para()}`,
  ).join("\n\n");
  const { blocks } = mrkdwnStringToBlocks(report);
  assert.ok(blocks.length <= MAX_BLOCKS, `blocks ${blocks.length} <= ${MAX_BLOCKS}`);
});

test("long-form report preserves ALL sections (no silent drop at a heading)", () => {
  // Regression: a long multi-section report used to be silently cut at ~section
  // 14 because each segment became a section + a divider block, hitting the
  // 50-block cap. The tail (METHODOLOGY, NEXT STEPS, …) vanished with no notice.
  const report = REPORT_TITLES.map(
    (t) => `*${t}*\n${para()} ${para()}\n\n${para()} ${para()}`,
  ).join("\n\n");
  const { blocks } = mrkdwnStringToBlocks(report);
  const body = bodyText(blocks);
  const dropped = REPORT_TITLES.filter((t) => !body.includes(t));
  assert.deepEqual(dropped, [], `no sections dropped (missing: ${dropped.join(", ")})`);
  assert.doesNotMatch(body, /message truncated/, "nothing was truncated, so no notice");
});

test("genuinely oversized report shows a VISIBLE truncation notice, not a silent cut", () => {
  // >150KB of packed text cannot fit even after dropping dividers. Keep what
  // fits and end with a visible indicator naming the omitted-section count.
  const huge = Array.from(
    { length: 400 },
    (_, i) => `*SECTION ${i} HEADING HERE*\n` + para().repeat(6),
  ).join("\n\n");
  const { blocks } = mrkdwnStringToBlocks(huge);
  assert.ok(blocks.length <= MAX_BLOCKS);
  const body = bodyText(blocks);
  assert.match(body, /message truncated — \d+ more sections omitted/);
  // The notice is the final block.
  const last = blocks[blocks.length - 1];
  assert.match(last.text.text, /message truncated/);
});

test("every section block stays within the 3000-char mrkdwn limit", () => {
  const report = REPORT_TITLES.map(
    (t) => `*${t}*\n${para()} ${para()} ${para()}`,
  ).join("\n\n");
  const { blocks } = mrkdwnStringToBlocks(report);
  for (const b of blocks) {
    if (b.type === "section" && b.text?.type === "mrkdwn") {
      assert.ok(
        b.text.text.length <= MAX_MRKDWN_CHARS,
        `section length ${b.text.text.length} <= ${MAX_MRKDWN_CHARS}`,
      );
    }
  }
});

test("empty input yields a single safe placeholder block", () => {
  const { blocks, text } = mrkdwnStringToBlocks("");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "section");
  assert.equal(text, " ");
});
