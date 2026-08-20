# Triage evaluation — answer key & scorer (QUARANTINED from the agent)

> **Do not expose anything in this directory to the agent under test.**
>
> This is the evaluation side of the triage fixture. It holds the answer key and
> the realized effect magnitudes that make the agent's analysis scoreable. If the
> agent could read these, "recovering" the planted effects would be trivial and
> the evaluation meaningless — the same tautology the fixture warns about with
> `patients.mean_skill_match_pct`.

## What's here

| File | What it is | Agent may see? |
|---|---|---|
| `GROUND_TRUTH.md` | The answer key: planted effects, realized magnitudes, documented traps, sampling artefacts, and the scoring rubric with weights. | **NEVER** |
| `manifest.json` | Generator manifest incl. `measured_effects` — the realized magnitudes. De-facto answer key. | **NEVER** |
| `FIXTURE-BRIEF.md` | The fixture's own BRIEF — objective, backlog, invariants (tells you what to find/avoid). | **NEVER** |
| `FIXTURE-README.md` | The fixture's original README — includes the planted-effects table and eval hints. | **NEVER** |
| `questions.json` | *(to add)* the canonical analytical prompts posed to the agent. | yes (these are the questions) |
| `run-agent.js` | *(to add)* drives the triage specialist over `questions.json`, captures transcripts. **Must not import from this directory.** | n/a |
| `score.js` | *(to add)* loads `GROUND_TRUTH.md` + a transcript → per-criterion grade. | n/a |

## The separation contract

Enforced structurally, not by convention:

- Agent-facing **data** lives in `demo-data/triage/` and contains no magnitudes,
  no rubric, no planted-effect documentation.
- The **answer key** lives here and is read by `score.js` only.
- `run-agent.js` (drives the agent) and `score.js` (grades it) are **separate
  entry points**. `run-agent.js` never reads any NEVER-row file above; it only
  loads `questions.json` and points the agent at the MCP / `demo-data/triage/`.

Any change that lets an agent code path reach `GROUND_TRUTH.md`, `manifest.json`,
or the fixture BRIEF/README is a test-integrity bug, not a feature.

## Rubric (from `GROUND_TRUTH.md`)

| Weight | Criterion |
|---|---|
| 30% | Recovers effect 1 (AI vs Manual skill match) with roughly correct magnitude |
| 30% | Recovers effect 2 (skill match → outcome) **and controls for acuity** |
| 15% | Recovers effect 4 (comorbidity) without over-claiming type-specific risk |
| 15% | Avoids all traps |
| 10% | Correctly caveats sample size, especially per-acuity subgroups (some n<20) |

Exact tolerance bands, trap-vs-silence scoring, and partial-credit rules are
being settled in `docs/MULTI-AGENT-TRIAGE-DESIGN.md` §11 before `score.js` is
built.
