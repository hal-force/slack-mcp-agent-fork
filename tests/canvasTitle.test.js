const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanTitle,
  deriveTitleFromText,
  deriveTitleFromReportText,
  titledCanvasMarkdown,
  generateCanvasTitle,
} = require("../src/canvas/canvasTitle");

// ---- cleanTitle: normalize a raw model/heuristic string into one title line ----

test("cleanTitle strips heading markers, quotes, markdown, and trailing punctuation", () => {
  assert.equal(cleanTitle("# OTF Grants Overview."), "OTF Grants Overview");
  assert.equal(cleanTitle('"Quarterly Funding Report"'), "Quarterly Funding Report");
  assert.equal(cleanTitle("**Youth Fund** _Analysis_"), "Youth Fund Analysis");
  assert.equal(cleanTitle("`Data Quality Review`:"), "Data Quality Review");
});

test("cleanTitle keeps only the first non-empty line", () => {
  assert.equal(cleanTitle("\n\nGrant Funding Trends\nsome preamble note"), "Grant Funding Trends");
});

test("cleanTitle collapses whitespace and caps very long titles", () => {
  assert.equal(cleanTitle("A    B\tC"), "A B C");
  const long = cleanTitle("word ".repeat(60));
  assert.ok(long.length <= 120, "capped to <=120 chars");
  assert.doesNotMatch(long, /\s$/, "no trailing whitespace after cap");
});

test("cleanTitle returns empty string for empty/nullish input", () => {
  assert.equal(cleanTitle(""), "");
  assert.equal(cleanTitle(null), "");
  assert.equal(cleanTitle(undefined), "");
});

// ---- deriveTitleFromText: deterministic fallback from the user request ----

test("deriveTitleFromText title-cases leading words (short words stay lowercase) and drops a polite prefix", () => {
  // "please" prefix is stripped; short words (<=2 chars: a, on, by) stay lowercase.
  assert.equal(
    deriveTitleFromText("please create a report on OTF grant funding by program"),
    "Create a Report on OTF Grant Funding by",
  );
});

test("deriveTitleFromText never returns empty — falls back to Untitled Canvas", () => {
  assert.equal(deriveTitleFromText(""), "Untitled Canvas");
  assert.equal(deriveTitleFromText("   "), "Untitled Canvas");
});

test("deriveTitleFromText caps at 8 words", () => {
  const t = deriveTitleFromText("one two three four five six seven eight nine ten");
  assert.equal(t.split(" ").length, 8);
});

// ---- titledCanvasMarkdown: prepend the title as the canvas's first section ----

test("titledCanvasMarkdown prepends the title as a leading # H1", () => {
  const out = titledCanvasMarkdown("*OTF SUMMARY*\n\nBody text.", "OTF Grants Overview");
  assert.match(out, /^# OTF Grants Overview\n\n/);
  assert.ok(out.includes("*OTF SUMMARY*"), "original body preserved");
});

test("titledCanvasMarkdown does not double-title when the body already starts with an H1", () => {
  const body = "# Existing Title\n\nBody.";
  assert.equal(titledCanvasMarkdown(body, "New Title"), body);
});

test("titledCanvasMarkdown returns the body unchanged when there is no title", () => {
  assert.equal(titledCanvasMarkdown("Body only.", ""), "Body only.");
  assert.equal(titledCanvasMarkdown("Body only.", null), "Body only.");
});

// ---- deriveTitleFromReportText: pick a specific heading from the report body ----

test("deriveTitleFromReportText skips a generic first heading for a specific one", () => {
  const report =
    "*EXECUTIVE SUMMARY*\nThe fund did well.\n\n*OTF GRANT FUNDING TRENDS*\nDetails here.";
  // Skips EXECUTIVE SUMMARY; keeps the first specific ALL-CAPS heading verbatim
  // (title-casing it would corrupt the "OTF" acronym).
  assert.equal(deriveTitleFromReportText(report), "OTF GRANT FUNDING TRENDS");
});

test("deriveTitleFromReportText falls back to the first non-empty line", () => {
  assert.equal(deriveTitleFromReportText("Quarterly revenue rose sharply this year."), "Quarterly Revenue Rose Sharply This Year");
});

test("deriveTitleFromReportText returns Untitled Canvas for empty input", () => {
  assert.equal(deriveTitleFromReportText(""), "Untitled Canvas");
  assert.equal(deriveTitleFromReportText("   \n  \n"), "Untitled Canvas");
});

// ---- generateCanvasTitle: deterministic, no LLM call ----

test("generateCanvasTitle prefers the user's own request phrasing (preserves acronyms)", async () => {
  const title = await generateCanvasTitle("*EXECUTIVE SUMMARY*\nBig report body.", {
    userMessage: "please create a report on OTF grant funding by program",
  });
  assert.equal(title, "Create a Report on OTF Grant Funding by");
});

test("generateCanvasTitle falls back to the report body when no user message", async () => {
  const title = await generateCanvasTitle("*EXECUTIVE SUMMARY*\nBody.\n\n*YOUTH FUND OUTCOMES*\nMore.", {});
  assert.equal(title, "YOUTH FUND OUTCOMES");
});

test("generateCanvasTitle never throws and never returns empty", async () => {
  assert.equal(await generateCanvasTitle("", {}), "Untitled Canvas");
  assert.equal(await generateCanvasTitle(null, { userMessage: "" }), "Untitled Canvas");
});
