# Nurse Triage — Methods & Scoring (reviewer's guide)

**Audience:** anyone who wants to review the triage capability end-to-end — how it
works, what analytical methods it uses, and how its quality is *objectively measured*.
**Scope:** the multi-agent Triage Specialist, the deterministic nurse ranker, the tool
layer they share, the synthetic data behind them, and the evaluation harness that grades
the analysis against a quarantined answer key.

> **All triage data is SYNTHETIC.** No real patients, nurses, or outcomes. The output is
> advisory and human-in-the-loop: the agent ranks and explains, the charge nurse decides.
> Nothing in this path takes clinical action.

---

## 1. What the triage capability is

Two related jobs over one synthetic hospital dataset:

1. **RECOMMENDATION** — *"Patient PT#### was just admitted. Which on-shift nurse should
   take them?"* Produces a ranked nurse list justified by skill fit and current workload,
   with a plain-language "why this pick," posted as a Slack card into an operations channel.
2. **ANALYSIS** — *"Does skill match actually reduce adverse outcomes? Compare AI-recommended
   vs. manual assignment. What looks like it matters but doesn't?"* Produces a numbers-backed
   answer that must control for confounders and refuse to over-claim.

Both are **flag-gated** (`AGENTS_ENABLED`, default **off**) so the baseline chat assistant
is byte-for-byte unchanged when the flag is off. The recommendation path is additionally
gated by a path secret on its HTTP trigger (see §7).

The two jobs share the same three tools and the same data, by design: the deterministic
ranker and the LLM specialist read identical numbers, so their recommendations agree.

---

## 2. Architecture at a glance

```
                          AGENTS_ENABLED (default OFF)
                                   │
   Slack turn ──► supervisor.js ───┤  off  → getAiResponse()   (baseline, untouched)
   (intent=TRIAGE) │               │
                   │               └─ on + TRIAGE → Triage Specialist (LLM) ─┐
                   │                                                          │
   HTTP POST ──► triageAdmissionTrigger.js ──► handleAdmission() ──► rankNurses() (deterministic)
   /triage/admission/<secret>                         │                       │
                                                       │  optional narrative ◄─┘
                                                       ▼
                                            triageCard.js  →  Slack channel card
                                                       ▲
        ┌──────────────────────────────────────────────┴───────────────┐
        │  triageTools.js  (3 tools: query / skill_gap / list_on_shift)  │
        └───────────────┬───────────────────────────────┬───────────────┘
                        │                                 │
              triageData.js (local CSV)         triageMcpData.js (Tableau via MCP)
              demo-data/triage/out/*.csv        published datasources (M4)
```

Key files (`src/agents/` unless noted):

| File | Responsibility |
|---|---|
| `defineAgent.js` | The multi-agent primitive: `(system prompt + tools + model pin + structured-output contract)` over the existing Bedrock tool loop. Adds nothing to the LLM plumbing. |
| `supervisor.js` | Coordination layer. Flag off → exact baseline. Flag on + TRIAGE intent → run the specialist as a deterministic sub-call, else baseline. Never black-holes a turn (falls back on error). |
| `triageSpecialist.js` | The role-specialized agent: the system prompt, the tool backend switch, and the model pin. |
| `triageTools.js` | The three tools the specialist calls + `dispatchTriageTool`. Carries **no** knowledge of which comparisons reveal a planted effect. |
| `triageData.js` | Local-CSV backend for the tools (deterministic, offline). |
| `triageMcpData.js` | Tableau-MCP backend (M4). Produces the **same** `{table: rows[]}` shape, so the tools and prompt are untouched. |
| `triageAdmission.js` | `rankNurses` (deterministic scorer) + `handleAdmission` (posts notice + card via an **injected** poster). |
| `triageCard.js` | Pure Block Kit renderers, incl. the deterministic "why this pick" rationale. |
| `composeTriageReply.js` | Turns a specialist result into the `{text, uploads, runSideEffects}` reply shape the handlers expect. |
| `src/jobs/triageAdmissionTrigger.js` | The authenticated, off-by-default HTTP endpoint that fires an admission. |
| `tests/eval/triage/` | The evaluation harness: questions, quarantined answer key, and the scorer. |

---

## 3. The data (synthetic fixture)

Generated with a fixed seed (`seed=42`, `dataset_version=2.0.0`) so the realized effect
magnitudes are stable and scoreable. Eight tables in `demo-data/triage/out/`:

`patients` (900) · `nurses` (20) · `nurse_skills` (112) · `patient_required_skills` (2047) ·
`assignments` (1665) · `unit_snapshots` (2880) · `clinical_notes` (127) · `skills_reference` (16).

The dataset is not random noise — it has **deliberately planted statistical effects** the
analysis agent is expected to recover, plus **traps** (plausible-looking non-effects) it is
expected to reject. The generator ran the outcome model *after* assignment, so effects are
structural, not labels pasted on:

```
P(adverse) = base(acuity)
             × (1 − 0.55 × mean_skill_match)      # skill match protects
             × (1 + 0.20 × mean_workload)         # workload hurts
             + 0.12 if comorbidity present        # flat, any type
```

**What the agent should recover** (realized magnitudes, from the answer key):

| # | Effect | Realized in this sample |
|---|---|---|
| 1 | AI-recommended vs. manual **skill match** | AI **75.0%** vs. Manual **33.1%** (different decision rules, not a relabel) |
| 2 | Higher skill match → **lower adverse rate** | ≥75% match: **17.1%** (n=315) vs. <75%: **27.9%** (n=585); overall 24.1% — **and it must control for acuity** |
| 3 | Higher skill match → **shorter LOS** (secondary) | 35.2 h vs. 74.8 h; confounded by acuity → partial credit only |
| 4 | **Comorbidity** raises adverse risk | flat **+0.12**, **uniform across types** — claiming type-specific risk is over-reading |

**Traps the agent should NOT report** (each is a documented confound or pure noise):
nurse experience → outcome, "unit X is more dangerous," diagnosis-independent-of-acuity,
night-shift risk, sex/age → outcome, and reading skill match off the circular
`patients.mean_skill_match_pct` validation column.

**Known sampling artefact (deliberate):** in the **Moderate** acuity band the high-match
cohort shows a *higher* adverse rate (21.9% vs. 16.0%, n=73/106) — the opposite of the
planted direction. An agent that reports the aggregate effect **while flagging that this
subgroup runs counter** is reasoning correctly; it is a caveat, not an error.

### The tautology guard

`patients.mean_skill_match_pct` is the outcome model's own input, present in the CSV only for
offline validation. Reading the skill-match→outcome effect off it is circular. The backend
**strips this column from every agent-facing table** (`FORBIDDEN_COLUMNS` in `triageData.js`
and `triageMcpData.js`), and the honest path — a `patient_mean_skill_match` derived *from the
assignments table* — is offered instead.

---

## 4. Methods — the deterministic ranker

`rankNurses(patientId, opts)` in `triageAdmission.js` is a pure, testable scorer. No LLM.

```
loadFrac = min(1, current_caseload / max_caseload)
score    = round( (skill_match_pct − workloadPenalty × loadFrac) × 10 ) / 10
```

- `workloadPenalty` defaults to **20**, i.e. a fully-loaded nurse is docked up to 20
  skill-match points. Skill fit dominates; workload breaks near-ties and penalizes overload.
- **Tie-breaks:** higher score → lower current caseload → lower `nurse_id` (stable, deterministic).
- Candidates, caseload, and per-nurse skill match come from `triage_list_nurses_on_shift`.
  Caseload is counted on each nurse's **most recent shift only**, so a month-long assignment
  log doesn't inflate current load into absurd numbers.

This ranking is the ground-truth-consistent ordering the LLM specialist should agree with.
It also lets the channel post a recommendation card **without a live LLM call** when only the
operational answer is needed — the specialist narrative is optional context layered on top.

`triageCard.js` renders the card and a deterministic **"why this pick"** rationale (case
complexity → skill/credential alignment + caseload headroom → score margin over the runner-up
→ a resource-nurse safeguard when required skills are uncovered). Every card carries the
`SYNTHETIC demo data · advisory only — the charge nurse decides.` tag.

---

## 5. Methods — the LLM Triage Specialist

`createTriageSpecialist()` in `triageSpecialist.js` is a `defineAgent` instance:
role system prompt + the three triage tools + a Bedrock model pin + a structured-output
contract. It runs on the existing Bedrock Converse tool loop — no new LLM plumbing.

### What the prompt carries — and deliberately does not

The system prompt carries **methodology**, the standing rules of a competent operations
analyst, but **zero knowledge** of which relationships are planted, at what magnitude, or
which factors are null. It must *discover* those from the data — otherwise the evaluation is
meaningless. The mandatory methodology rules:

- **Pull before you claim.** Every quantitative statement must trace to a `triage_query` it
  actually ran, showing the groups and their rates/means.
- **Acuity is the dominant confounder.** Before attributing any outcome difference to another
  factor, re-run the comparison *grouped by acuity band* and check the pattern holds. A raw
  difference that vanishes or reverses under acuity control is confounded — say so.
- **Distinguish derived from observed.** Never cite `patients.mean_skill_match_pct`; use the
  honest derived `patient_mean_skill_match` / `skill_match_bucket`.
- **Never fan out.** Don't join the two skill bridges into patients/assignments (it multiplies
  rows and inflates aggregates). Use `triage_skill_gap` for coverage.
- **Respect sample size.** Caveat any claim resting on a small cell (some per-acuity n < 20),
  and flag subgroups that run counter to the aggregate rather than hiding them.
- **Report the null.** "Tested, no effect" is a finding. Don't omit a plausible factor that
  proved null; don't report a relationship you couldn't demonstrate.

### The tool surface (`triageTools.js`)

Three Bedrock-shaped tools — the tools themselves carry no hint of which comparisons matter:

1. **`triage_query`** — grouped aggregation over **one** table (the primary analysis
   primitive; mirrors a VizQL `query-datasource`). Supports filters, `group_by`, and measures
   `count | count_distinct | mean | sum | rate | min | max`. Offers four honest **derived**
   columns computed on the fly: `comorbidity_present`, `patient_mean_skill_match`,
   `skill_match_bucket` (high/low split at a threshold, default 75), and `age_band`.
2. **`triage_skill_gap`** — required / covered / **missing** skills for a patient×nurse pair,
   computed by set intersection **without fanning out** the skill bridges.
3. **`triage_list_nurses_on_shift`** — candidate nurses + current caseload + optional per-nurse
   skill match for a newly-admitted patient (feeds the recommendation).

### The output contract

The specialist writes Slack prose first, then a **single trailing fenced ```json block**.
`defineAgent.extractStructured` parses that block into `structured` (best-effort; a missing or
malformed block yields `structured:null`, never throws) and strips it from the prose. The JSON
shape:

```jsonc
{
  "mode": "analysis" | "recommendation",
  "findings": [ { "effect": "<stable key>", "claim": "...", "magnitude": {...},
                  "controlled_for": ["acuity"], "confidence": "...", "caveats": [...] } ],
  "declined": ["night_shift_risk", "unit_risk", "nurse_experience", ...],
  "recommendation": { "patient_id": "...", "ranked_nurses": [...], "unit_risk_note": "..." }
}
```

Stable `effect` keys (`ai_vs_manual_skill_match | skill_match_to_outcome | comorbidity_risk |
skill_match_to_los | other`) are what make grading unambiguous (see §8).

### The model pin

The Bedrock model is pinned via `AGENT_TRIAGE_MODEL_ID` (falls back to the app's
`BEDROCK_MODEL_ID`). A **pinned model = reproducible eval scores**. The pin is threaded through
a Bedrock-only request key (`bedrockModelId`) that no baseline caller sets, so it can't perturb
any other path.

### Data backend switch (M2→M4)

`resolveDispatchTool` picks the backend without changing the prompt or tools:
- default → **local CSV** (`triageData.js`) — deterministic, offline, what every test/eval uses;
- `TRIAGE_MCP_DATASOURCES` set (a JSON `table→datasourceLUID` map) → **Tableau MCP**
  (`triageMcpData.js`), which reproduces the identical `{table: rows[]}` shape from published
  datasources. MCP fetches are **sequential** (the server holds a single PAT on HTTP transport;
  concurrent Tableau signins collide and silently drop rows).

---

## 6. How a turn flows (analysis vs. recommendation)

**Analysis (chat):** intent-classified `TRIAGE` → `supervisor.runSupervised`. Flag on →
`triageSpecialist.run({aiParams, intents})`. It reuses `respond.buildContents` so any thread
history from other participants stays **injection-fenced as untrusted data**. The specialist
loops over its tools, then emits prose + JSON; `composeTriageReply` shapes it into the reply.

**Recommendation (event-driven):** `POST /triage/admission/<secret>` → fast-ack 200 →
background `handleAdmission({patientId, channel, unit}, {postMessage, specialist})`.
`rankNurses` produces the deterministic ordering; the card renders from it; the optional
specialist narrative is attached as advisory context (**a specialist failure must not block the
operational card**). Posting uses an **injected** poster — nothing posts to a live channel on
its own; the caller owns authorization.

---

## 7. Safety & isolation properties (for reviewers)

- **Off by default.** `AGENTS_ENABLED` gates the whole multi-agent surface; when off, the
  supervisor is a pass-through to the exact baseline.
- **Authenticated trigger, off by default.** The admission endpoint arms **only** if
  `TRIAGE_ADMISSION_SECRET` is set; the secret sits in the path and is compared **timing-safely**
  (`safeEqual`). A bad/missing secret returns 404 (doesn't confirm the path exists); the layer
  also 409s if `AGENTS_ENABLED` is off. No unauthenticated channel-posting endpoint ever exists.
- **No implicit posting.** `handleAdmission` throws if no `postMessage` is injected.
- **Injection fencing carried through.** Untrusted thread/free-text content stays in the same
  fenced-as-data path as the chat assistant.
- **Answer-key quarantine (test integrity).** Agent-facing code reads **only**
  `demo-data/triage/`; it never reads anything under `tests/eval/triage/`. The specialist has no
  filesystem-read tool, so the answer key is unreachable by construction — the quarantine files
  are tracked in git but the agent structurally cannot see them.

---

## 8. Scoring — the evaluation harness

This is what makes the analysis **more than a demo**: its quality is graded numerically against
a known answer key, with a diagnosable per-criterion breakdown. Everything lives in
`tests/eval/triage/`.

### The separation contract (enforced by construction)

| File | Role | Agent may see? |
|---|---|---|
| `questions.json` | 5 canonical analytical prompts posed to the agent | **Yes** (they are the questions) |
| `run-agent.js` | Drives the specialist over the questions, writes a transcript | Driver — imports **only** the questions + the specialist |
| `score.js` | Grades a transcript against the key | Scorer — the **only** code allowed to read the key |
| `manifest.json` | Generator manifest incl. realized `measured_effects` | **NEVER** |
| `GROUND_TRUTH.md` | Answer key: planted effects, magnitudes, traps, rubric | **NEVER** |
| `FIXTURE-BRIEF.md`, `FIXTURE-README.md` | Fixture objective + planted-effects table | **NEVER** |

`run-agent.js` (drives the agent) and `score.js` (grades it) are **separate entry points**;
the driver never imports the scorer or any answer-key file. `scorer.test.js` includes a lint
that asserts the driver contains no reference to the answer-key files. **Any change that lets an
agent code path reach the answer key is a test-integrity bug, not a feature.**

### The questions (`questions.json`)

Five analysis prompts — deliberately including invitations to discuss factors that look
meaningful but aren't (a well-calibrated agent must decline those, not confabulate). They carry
**no magnitudes and no answer-key material**:

1. `q1_assignment_strategy` — AI vs. manual skill match: real difference, how large?
2. `q2_skill_match_outcome` — does higher skill match reduce adverse outcomes **once you account
   for acuity**?
3. `q3_comorbidity` — does comorbidity change risk; does the specific *type* matter?
4. `q4_rule_outs` — which patient/nurse/unit/shift/timing factors *look* causal but aren't? Be
   explicit about what you ruled out. (the traps)
5. `q5_synthesis` — summarize what genuinely drives outcomes, with magnitudes, and note subgroups
   where the pattern doesn't hold.

### The run (`run-agent.js`)

Manual / CI-gated (needs live Bedrock + the model pin) — **not** part of the offline `npm test`
suite. It runs the specialist over the questions and writes a transcript of
`{id, prompt, prose, structured}` per turn. `--baseline` runs the same questions through the
single-call `getAiResponse` instead (which emits no structured block) for an apples-to-apples
comparison — the baseline scores lower, which is the point. Checked-in reference transcripts:
`transcript.specialist.json` and `transcript.baseline.json`.

### The rubric (`score.js`) — 100 points

The scorer merges `findings`/`declined` across all turns (an effect may surface under any
question) and grades the merged view. It matches findings on the **stable effect key** first,
with a guarded claim-text fallback so effect 2's "skill match" phrasing can't accidentally
capture effect 1. Magnitude hits use a **locked ±8-point tolerance band**.

| Pts | Criterion | Rule |
|---|---|---|
| **30** | Effect 1 — AI vs. manual skill match | Full only if **direction right AND both means within ±8 pts** of the realized 75.0 / 33.1. Otherwise **0** (no partial). |
| **30** | Effect 2 — skill match → outcome | **Full (30)** only if the finding's `controlled_for` includes **acuity**. **Half (15)** if the effect is found but not acuity-controlled. **0** if not substantiated. |
| **15** | Effect 4 — comorbidity | Full if a **flat** effect is claimed with **no per-type over-claim**; a type-specific risk claim (e.g. "cirrhosis worse than hypertension") scores **0**. |
| **15** | Traps | Starts full; each of the 6 traps reported as real costs **−15/6 (2.5)**; an **explicit decline** scores full share, **silence** scores half that share; clamped to [0, 15]. |
| **10** | Small-subgroup caveat | Present if any caveat/prose flags small n / small subgroup / a subgroup running counter to the aggregate (e.g. the Moderate artefact). |

Output is a **per-criterion breakdown** (`[points/max] key — note`), never a bare number, so a
failure is diagnosable. The scorer is deterministic and dependency-free. Its own judgement logic
is unit-tested in `scorer.test.js` (part of the offline suite), so the rules that decide "is this
analysis good?" can't silently drift either.

### Reading a score

- **60/60 on effects 1+2** means the agent recovered both planted magnitudes *and* controlled for
  the dominant confounder — the hard part.
- **A dropped 15 on effect 2** almost always means the agent found the effect but didn't re-run it
  within acuity bands (the exact failure the methodology warns about).
- **Trap points below 15** means the agent asserted a confound/noise factor as real.
- **The 10-point caveat** rewards catching the deliberate Moderate-band reversal.

### Run it yourself

```bash
# 1. produce a transcript (needs live Bedrock + AGENT_TRIAGE_MODEL_ID pinned)
node tests/eval/triage/run-agent.js --out /tmp/transcript.json
node tests/eval/triage/run-agent.js --baseline --out /tmp/baseline.json   # comparison

# 2. grade it (score.js is the ONLY thing that reads the answer key)
node -e "const {scoreTranscript,formatReport}=require('./tests/eval/triage/score'); \
         console.log(formatReport(scoreTranscript(require('/tmp/transcript.json'))))"

# offline: the scorer's own logic is unit-tested without any live model
node --test tests/eval/triage/scorer.test.js
```

---

## 9. Design docs & source map

- **Design rationale & rubric §11:** `docs/MULTI-AGENT-TRIAGE-DESIGN.md`
- **Fork-level change context (themes 7–8):** `docs/CHANGES-VS-UPSTREAM.md`
- **Enabling triage on a deployment (env flags):** `deploy/aws/DEPLOY-SCRIPTED.md` (the "Multi-agent / triage surface" section) — `AGENTS_ENABLED`, `TRIAGE_ADMISSION_SECRET`, `TRIAGE_CHANNEL_ID`, `TRIAGE_MCP_DATASOURCES`, `AGENT_TRIAGE_MODEL_ID`
- **Agents:** `src/agents/{defineAgent,supervisor,triageSpecialist,triageAdmission,triageCard,triageTools,triageData,triageMcpData,composeTriageReply}.js`
- **Trigger:** `src/jobs/triageAdmissionTrigger.js`
- **Evaluation:** `tests/eval/triage/{questions.json,run-agent.js,score.js,scorer.test.js}` +
  the quarantined `{manifest.json,GROUND_TRUTH.md,FIXTURE-*.md}`
- **Synthetic data:** `demo-data/triage/out/*.csv`

*All triage data is synthetic; output is advisory and human-in-the-loop.*
