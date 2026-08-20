# BRIEF — what this repo is for

> **Read this before `CLAUDE.md`.** This file states the objective. `CLAUDE.md`
> states the working rules. You need both.
>
> Sections marked **[CONFIRM]** were inferred when this repo was scaffolded and
> have not been verified by the repo owner. Ask before building on them.

---

## The objective

We are building an **AI-assisted nurse assignment system**. Given a new patient
intake, it recommends which nurse on shift should take the patient, justified by
skill fit and current workload, and it explains how the assignment changes the
unit's overall risk profile.

An **analysis agent reaches this data through the Tableau MCP server** and is
expected to answer operational questions about it — comparing assignment
strategies, identifying skill gaps, spotting staffing risk.

**This repo is not that system.** It is the *test fixture* the system is
evaluated against. Its entire job is to produce data that can tell a good agent
from a bad one.

## Why the fixture is the hard part

The naive version of this dataset is randomly generated and therefore contains
no relationships at all. An agent pointed at it will either correctly report
"no signal" — which tells you nothing about the agent — or confabulate patterns
from noise, which actively rewards hallucination.

An earlier version of this dataset had exactly that defect: `assignment_method`
was assigned at random, independent of every other column, while the
documentation claimed AI-recommended assignments produced better outcomes. They
did not. There was nothing there.

So the design principle is:

> **If the documentation claims a relationship, the generator must actually
> produce it, and `validate.py` must verify it is present, correctly directed,
> and statistically detectable.**

`out/GROUND_TRUTH.md` is the artifact that makes agent evaluation possible. It
is regenerated on every run and records the planted effects at the magnitudes
actually realised in that sample, plus the traps a well-calibrated agent should
decline to report. **Never expose it to the agent under test.**

## Current state

Working and validated:

- Deterministic generator producing 8 linked tables (~900 patients, 30-day window)
- Two planted effects with verified magnitudes and statistical power
- Documented traps (null-signal columns that look meaningful)
- Free-text clinical notes, internally consistent with the structured record
- 37-check validator covering integrity, schema, clinical coherence, and effect power
- Self-contained `.twbx` with five datasources

Run `make all` and read the validator output. If it exits non-zero, fix that
before anything else.

---

## Backlog

### 1. Scoring harness **[highest value, do this first]**

There is currently no way to score an agent's analysis except by reading it.
`GROUND_TRUTH.md` already contains a rubric with weights; nothing consumes it.

Build a tool that takes an agent's analysis output and grades it against the
ground truth for that dataset. Suggested shape:

```bash
python score.py --data out --transcript agent_output.md
```

Design questions worth raising before you build:

- **Extraction.** Does the agent's output get parsed for claimed effects and
  magnitudes, or does the agent emit structured JSON alongside its prose? The
  second is easier to score and less realistic. Consider supporting both.
- **Tolerance.** An agent reporting a 38-point skill-match gap when the truth is
  42 is substantially correct. What band counts as a hit?
- **Trap scoring.** Silence on a trap should score the same as an explicit
  "no relationship found" — or should explicit refusal score higher? This is a
  real design choice about what behaviour you want to reward.
- **Partial credit.** Recovering effect 2 without controlling for acuity is a
  weaker result than recovering it with control. The rubric says "credit
  partial" but does not define how much.

Output should be a per-criterion breakdown, not a single number, so a failure is
diagnosable.

### 2. Agent-facing view that excludes validation columns

`patients.mean_skill_match_pct` is an input to the outcome model, exposed for
validation. An agent that reads the effect off that column has done nothing.
Produce a filtered export, or a Tableau datasource, with the validation aids
removed. See the derived-columns table in `GROUND_TRUTH.md` for the full list.

### 3. Harder scenarios

The current fixture has a clean signal. Real evaluation needs cases where the
right answer is "insufficient evidence" or "the obvious reading is wrong":

- A seed where an effect genuinely reverses in a subgroup, documented as such,
  to test whether the agent notices and caveats rather than over-generalising
- Missing data — nurses with no recorded skills, assignments with no matching
  patient record — to test whether the agent reports the gap or silently drops rows
- A dataset with the planted effects switched **off** entirely, to test whether
  the agent correctly reports finding nothing. This is the single best test for
  confabulation and currently does not exist.

### 4. Tableau workbook verification

`build_twbx.py` emits well-formed XML that has never been checked against
Tableau's own parser. Someone with Desktop needs to open it once and report
back. If it fails, the likely culprits are the `<relation>` join block or a
`column-instance` naming mismatch.

### 5. Clinical review **[CONFIRM]**

The comorbidity histories and diagnosis-specific findings are plausible but were
not written or reviewed by a clinician. If this fixture is going to be shown to
a clinical audience, that review should happen first. Flag anything that reads
wrong rather than assuming it was deliberate.

---

## Kickoff prompt

Paste this to start a session:

```
This repo generates a synthetic hospital triage dataset used as a test fixture
for an AI-assisted nurse assignment system. Read BRIEF.md and CLAUDE.md first.

The fixture contains deliberately planted statistical effects, and
out/GROUND_TRUTH.md is the answer key that lets an agent's analysis be scored.
The critical invariant: if the docs claim a relationship, the generator must
actually produce it and validate.py must verify it.

Start by running `make all` and confirming the validator passes clean. Then
work item 1 from the backlog: the scoring harness. Before you write code, walk
me through the design questions in that section — I want to settle the
tolerance bands and trap-scoring rules before implementation.
```

Swap the last paragraph for whichever backlog item you actually want.

## Constraints

- **Synthetic only.** No real patient, clinician, or facility data enters this
  repo under any circumstances. Every emitted row carries
  `data_classification=SYNTHETIC`; new tables must too.
- **Standard library only.** The generator runs unchanged in an air-gapped
  environment with no package index reachable. Do not add a dependency without
  raising it first.
- **`validate.py` is the gate.** It exits non-zero on failure so it can run in
  CI. Do not weaken a check to make a build pass — if a check is wrong, say so
  and fix the check deliberately.
