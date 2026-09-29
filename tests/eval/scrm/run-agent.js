/**
 * run-agent.js — drive the SCRM specialist over the canonical questions and capture a
 * transcript for scoring. MANUAL / CI-gated (needs a live LLM provider — Cohere Command
 * A Plus for this build — plus the published Tableau datasources via SCRM_MCP_DATASOURCES,
 * or the local CSV backend when that env var is unset); NOT part of the offline
 * `npm test` suite.
 *
 * ── Separation contract (enforced by construction) ────────────────────────
 * This file drives the AGENT. It therefore must NEVER read the answer key. It imports
 * ONLY:
 *   - questions.json (the prompts — the agent is allowed to see these)
 *   - the specialist itself (src/agents/scrmSpecialist)
 * It does NOT require ./score.js, ./manifest.json, ./GROUND_TRUTH.md, or any FIXTURE-*.
 * Scoring is a SEPARATE step (score.js) run afterwards on the transcript this writes. A
 * lint check in scorer.test.js asserts this file has no reference to the answer-key files.
 *
 * Usage:
 *   node tests/eval/scrm/run-agent.js               # specialist over the questions → transcript.json
 *   node tests/eval/scrm/run-agent.js --baseline    # same questions via getAiResponse (comparison)
 *   node tests/eval/scrm/run-agent.js --out foo.json
 *
 * Then:  node -e "const {scoreTranscript,formatReport}=require('./tests/eval/scrm/score');
 *                  console.log(formatReport(scoreTranscript(require('./tests/eval/scrm/transcript.json'))))"
 */

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const QUESTIONS = path.join(HERE, "questions.json");

function parseArgs(argv) {
  const args = { baseline: false, out: path.join(HERE, "transcript.json") };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--baseline") args.baseline = true;
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

async function runSpecialist(questions) {
  const { createScrmSpecialist } = require("../../../src/agents/scrmSpecialist");
  const spec = createScrmSpecialist();
  const transcript = [];
  for (const q of questions) {
    process.stderr.write(`[run-agent] specialist ← ${q.id}\n`);
    const res = await spec.run({ aiParams: { userMessage: q.prompt }, intents: ["scrm"] });
    transcript.push({ id: q.id, prompt: q.prompt, prose: res.text, structured: res.structured });
  }
  return transcript;
}

async function runBaseline(questions) {
  // The single-call baseline for an apples-to-apples comparison. Uses the same SCRM
  // tools so the only variable is the specialist role prompt + coordination.
  const { getAiResponse } = require("../../../src/assistant/respond");
  const transcript = [];
  for (const q of questions) {
    process.stderr.write(`[run-agent] baseline ← ${q.id}\n`);
    const res = await getAiResponse({ userMessage: q.prompt, useFullModel: true });
    transcript.push({ id: q.id, prompt: q.prompt, prose: res.text, structured: null });
  }
  return transcript;
}

async function main() {
  const args = parseArgs(process.argv);
  const { questions } = JSON.parse(fs.readFileSync(QUESTIONS, "utf8"));
  const transcript = args.baseline ? await runBaseline(questions) : await runSpecialist(questions);
  fs.writeFileSync(args.out, JSON.stringify(transcript, null, 2));
  process.stderr.write(`[run-agent] wrote ${transcript.length} turns → ${args.out}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[run-agent] ERROR: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

module.exports = { runSpecialist, runBaseline, parseArgs };
