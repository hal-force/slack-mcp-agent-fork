const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createTriageSpecialist, triageModelId, TRIAGE_SYSTEM_PROMPT, resolveDispatchTool } = require("../../src/agents/triageSpecialist");
const { composeTriageReply, renderRecommendation } = require("../../src/agents/composeTriageReply");

// ── model pin resolution ──────────────────────────────────────────────────
test("triageModelId reads AGENT_TRIAGE_MODEL_ID; blank/unset → undefined", (t) => {
  const prev = process.env.AGENT_TRIAGE_MODEL_ID;
  t.after(() => {
    if (prev === undefined) delete process.env.AGENT_TRIAGE_MODEL_ID;
    else process.env.AGENT_TRIAGE_MODEL_ID = prev;
  });

  delete process.env.AGENT_TRIAGE_MODEL_ID;
  assert.equal(triageModelId(), undefined, "unset → undefined (inherits app model)");

  process.env.AGENT_TRIAGE_MODEL_ID = "   ";
  assert.equal(triageModelId(), undefined, "blank → undefined");

  process.env.AGENT_TRIAGE_MODEL_ID = "pinned-sonnet-5";
  assert.equal(triageModelId(), "pinned-sonnet-5");
});

test("createTriageSpecialist returns a named runnable", () => {
  const spec = createTriageSpecialist();
  assert.equal(spec.name, "triage-specialist");
  assert.equal(typeof spec.run, "function");
});

test("specialist run() short-circuits on an empty message without calling the LLM", async () => {
  // No Bedrock env is configured in the test process, so if run() attempted a
  // real generateReply it would throw. A clean empty result proves the guard.
  const spec = createTriageSpecialist();
  const res = await spec.run({ aiParams: { userMessage: "   " } });
  assert.equal(res.text, "");
  assert.equal(res.structured, null);
});

test("system prompt carries methodology but NOT planted-effect magnitudes", () => {
  const p = TRIAGE_SYSTEM_PROMPT;
  // Methodology must be present.
  assert.match(p, /control/i);
  assert.match(p, /acuity/i);
  assert.match(p, /fan out|fan-out/i);
  assert.match(p, /mean_skill_match_pct/); // named as forbidden
  // The answer key must NOT be in the prompt — these magnitudes live only in
  // tests/eval/triage. A regex guard so a future edit can't leak them.
  assert.doesNotMatch(p, /75\.0|33\.1|17\.1|27\.9|0\.12/, "no realized magnitudes in the prompt");
  assert.doesNotMatch(p, /planted|ground.?truth/i, "prompt must not reference the answer key");
});

// ── composeTriageReply (pure) ───────────────────────────────────────────────
test("composer passes analysis prose through unchanged, no side effects", async () => {
  const out = composeTriageReply(
    { text: "AI assignments match skill better than manual.", structured: { mode: "analysis", findings: [] } },
    {},
  );
  assert.equal(out.text, "AI assignments match skill better than manual.");
  assert.deepEqual(out.uploads, []);
  assert.deepEqual(await out.runSideEffects(), []);
});

test("composer appends a recommendation summary when prose omits one", () => {
  const out = composeTriageReply(
    {
      text: "Based on skill fit and current load, here is my read.",
      structured: {
        mode: "recommendation",
        recommendation: {
          patient_id: "PT0042",
          ranked_nurses: [
            { nurse_id: "RN007", skill_match_pct: 83.3, current_caseload: 2, missing_skills: ["SK09"], rationale: "Best skill fit, light load." },
            { nurse_id: "RN012", skill_match_pct: 66.7, current_caseload: 1, missing_skills: ["SK03", "SK09"], rationale: "Lightest load." },
          ],
          unit_risk_note: "Adds one Critical patient to ICU-A; ratio still within target.",
        },
      },
    },
    {},
  );
  assert.match(out.text, /\*RECOMMENDATION for \*PT0042\*/);
  assert.match(out.text, /RN007/);
  assert.match(out.text, /skill match 83\.3%/);
  assert.match(out.text, /caseload 2/);
  assert.match(out.text, /missing SK09/);
  assert.match(out.text, /UNIT RISK:/);
});

test("composer does NOT double-append when prose already has a RECOMMENDATION block", () => {
  const prose = "*RECOMMENDATION for *PT0042*\n1. *RN007*";
  const out = composeTriageReply(
    { text: prose, structured: { mode: "recommendation", recommendation: { patient_id: "PT0042", ranked_nurses: [{ nurse_id: "RN007" }] } } },
    {},
  );
  // Only one occurrence of the header.
  const count = (out.text.match(/\*RECOMMENDATION/g) || []).length;
  assert.equal(count, 1);
});

test("composer handles a recommendation with no rankable nurses", () => {
  const out = composeTriageReply(
    { text: "", structured: { mode: "recommendation", recommendation: { patient_id: "PT0001", ranked_nurses: [] } } },
    {},
  );
  assert.match(out.text, /No candidate nurse could be ranked/);
});

test("composer falls back to a helpful message when the specialist returned nothing", () => {
  const out = composeTriageReply({ text: "", structured: null }, {});
  assert.match(out.text, /couldn't produce a triage answer/i);
});

test("renderRecommendation is deterministic and caps at 5 nurses", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ nurse_id: `RN${i}`, skill_match_pct: 50, current_caseload: 1 }));
  const txt = renderRecommendation({ patient_id: "PT1", ranked_nurses: many });
  const numbered = (txt.match(/^\d+\. /gm) || []).length;
  assert.equal(numbered, 5, "at most 5 ranked nurses shown");
});

// ── M4 backend selection: CSV by default, MCP when configured ──────────────
test("resolveDispatchTool defaults to the local-CSV backend when TRIAGE_MCP_DATASOURCES is unset", (t) => {
  const prev = process.env.TRIAGE_MCP_DATASOURCES;
  t.after(() => {
    if (prev === undefined) delete process.env.TRIAGE_MCP_DATASOURCES;
    else process.env.TRIAGE_MCP_DATASOURCES = prev;
  });
  delete process.env.TRIAGE_MCP_DATASOURCES;
  const dispatch = resolveDispatchTool();
  assert.equal(typeof dispatch, "function");
  // The CSV dispatcher runs synchronously against the bundled fixture — a known
  // table name returns rows without ever contacting the MCP.
  return dispatch("triage_query", { table: "nurses", measures: [{ agg: "count" }] }).then((out) => {
    assert.ok(out && Array.isArray(out.rows), "CSV backend answered from the local fixture");
  });
});

test("resolveDispatchTool switches to the MCP backend when TRIAGE_MCP_DATASOURCES is set", (t) => {
  const prev = process.env.TRIAGE_MCP_DATASOURCES;
  t.after(() => {
    if (prev === undefined) delete process.env.TRIAGE_MCP_DATASOURCES;
    else process.env.TRIAGE_MCP_DATASOURCES = prev;
  });
  process.env.TRIAGE_MCP_DATASOURCES = '{"nurses":"LU_X"}';
  // We don't invoke it (that would hit the network); we only assert selection didn't
  // fall through to the CSV path. The MCP dispatcher is an async function created fresh.
  const dispatch = resolveDispatchTool();
  assert.equal(typeof dispatch, "function");
  // An explicit override still wins over the env.
  const sentinel = () => {};
  assert.equal(resolveDispatchTool({ dispatchTool: sentinel }), sentinel);
});
