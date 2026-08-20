# Multi-Agent Architecture — Triage Specialist (first vertical slice)

**Status:** BUILT (M1–M4) · **Author:** design pass 2026-08-19, updated 2026-08-20 · **Flag:** `AGENTS_ENABLED` (default off)

> **Update 2026-08-20 — this is now built and deployed.** What began as the proposal
> below shipped as milestones M1–M4 on the reference deployment:
>
> - **M1** — the reusable `defineAgent` primitive + a flag-gated supervisor
>   (`src/agents/defineAgent.js`, `supervisor.js`), baseline-neutral when
>   `AGENTS_ENABLED` is off.
> - **M2** — the triage specialist (analysis + recommendation) + the in-repo
>   evaluation harness (`src/agents/triageSpecialist.js`, `triageTools.js`,
>   `tests/eval/triage/`).
> - **M3** — admission → operations-channel recommendation card, behind a
>   secret-gated HTTP trigger (`src/agents/triageAdmission.js`, `triageCard.js`,
>   `src/jobs/triageAdmissionTrigger.js`).
> - **M4** — the specialist repointed onto **published Tableau datasources** via the
>   MCP (`src/agents/triageMcpData.js`), so it runs on live server data rather than
>   local CSVs. The recommendation card also carries a deterministic "why this pick"
>   rationale.
>
> The material below is the original design pass. The "Decisions locked" table held;
> the "Still open" items in §11 were resolved during implementation. Read it as the
> rationale behind the shipped code, not a to-do list.

## Decisions locked (2026-08-19)

| # | Decision | Choice |
|---|---|---|
| Mode | Which specialist mode M2 builds first | **Analysis mode** (scoreable) before recommendation mode |
| Scorer | Where scoring lives | **In-repo JS** (`tests/eval/triage/score.js`), runs in `npm test` |
| Coupling | Specialist ↔ main agent | **Deterministic sub-call** (supervisor composes the structured result) |
| Data | Fixture into repo / publish | **Copied in** (done); Tableau publish **deferred** until a site is authorized |

Still open (need sign-off before `score.js` / specialist prompt are final): tolerance
band, trap-vs-silence scoring, partial-credit rule, specialist model pin — see §11.

## Answer-key separation (non-negotiable invariant)

The fixture is an *evaluation* fixture: it only works if the agent under test never
sees the answer key. This is enforced **structurally**, already in place:

- **Agent-facing data** → `demo-data/triage/` (CSVs + `.twbx` + a neutral data
  dictionary). Contains **no** magnitudes, rubric, or planted-effect docs.
- **Answer key** → `tests/eval/triage/` (`GROUND_TRUTH.md`, `manifest.json`'s
  `measured_effects`, the fixture BRIEF and original README). Read by `score.js`
  **only**.
- `run-agent.js` (drives the agent) and `score.js` (grades it) are separate entry
  points; the former never imports from the answer-key set.

`manifest.json` and the fixture's original README were moved OUT of the
agent-facing dir because they carry realized magnitudes / planted-effect tables —
reading them would be the same tautology the fixture warns about with
`patients.mean_skill_match_pct`.

---

## 1. Goal

Introduce the first **role-specialized agent** — a **Triage Specialist** — coordinated
by a lightweight **Supervisor**, and prove it produces measurably better analysis
than today's single-call path, scored against a fixture with a known answer key.

This is the concrete first step of the deferred federal roadmap
(`memory/federal-features-roadmap.md`, item 2: "multiple agents with specific
roles / supervisor"). The Triage Specialist is the lighthouse that forces the
reusable `defineAgent` primitive into existence; every later specialist
(Analyst, Writer, Reviewer, Caseworker, Notifier) reuses it.

### The scenario

A new patient is admitted. The specialist, reaching hospital data **through the
Tableau MCP server**, answers two kinds of question:

1. **Operational (decision-support):** "PT#### was just admitted — which nurse on
   shift should take them?" → a ranked recommendation justified by skill fit and
   current workload, with the effect on the unit's risk profile.
2. **Analytical (scoreable):** "Does skill match predict adverse outcomes? Control
   for acuity." / "Compare AI-recommended vs manual assignment skill match." →
   the questions the fixture plants verifiable effects for.

Both are the same specialist. #1 is the demo-friendly operational surface; #2 is
what makes quality **objectively measurable**.

## 2. Non-goals (for this slice)

- Not building the event-driven trigger / case-management primitives yet (later
  roadmap items). Supervisor stays request/response.
- Not rewriting `intentRouter` or the skills registry. Both stay; the supervisor
  sits *above* them.
- Not touching the live VHA daily-brief or Tableau webhook paths.
- Not autonomous clinical action. Every output is **advisory, human-in-the-loop,
  synthetic-only**.

## 3. Background — how the agent works today

The current flow (`src/index.js` app_mention & assistant handlers) is:

```
event → classifyIntent()        (src/router/intentRouter.js)
      → resolveActiveSkills()    (src/skills/registry.js)
      → executeActiveSkills()    ← skills run in PARALLEL, each returns a context block
      → getAiResponse()          (src/assistant/respond.js)  ← ONE reasoning call
      → runSideEffects()         (canvas writes)
```

Two facts that shape the design:

- **There is exactly one reasoning call.** "Skills" are *context-fetchers*, not
  agents — they gather Slack/Tableau/web context that is concatenated into a
  single `getAiResponse` prompt. `executeActiveSkills` returns
  `{ contextParts, uploads, sideEffects, systemPromptSections }` — data, not
  reasoning.
- **The only agentic loop today** is the Bedrock tool loop inside
  `generateWithBedrock` (`src/assistant/llmProvider.js`), which services
  `tool_use` stops against `TABLEAU_TOOL_SPECS` up to `BEDROCK_MAX_TOOL_ROUNDS`.
  This is the machinery a specialist reuses to actually query Tableau in-turn.

So "multi-agent" = **add a layer of role-specialized reasoning calls above the
existing single call**, not a rewrite of it.

## 4. Proposed architecture

```
                 index.js handler  (sequencing unchanged)
                        │
                 ┌──────▼───────┐
                 │  Supervisor  │   NEW — thin; default branch == today's path
                 └──────┬───────┘
        triage intent?  │  no → getAiResponse()  (unchanged baseline)
             yes ▼
        ┌─────────────────────┐
        │  Triage Specialist  │   NEW — defineAgent() instance
        │  own prompt + tools │
        └──────────┬──────────┘
                   │ reuses generateReply()'s Bedrock tool loop
                   ▼
        Tableau MCP  (triage datasources)  +  skill-gap tool
                   │
                   ▼
        { recommendation, analysis, structured } → Supervisor composes Slack reply
```

### 4.1 `defineAgent` primitive — `src/agents/defineAgent.js` (NEW)

A thin wrapper over the existing `generateReply`. A "role" is nothing more than
*(system prompt + tool set + model tier + output contract)*. It reuses 100% of
the provider abstraction and Bedrock tool loop — no new LLM plumbing.

```js
// defineAgent({ name, systemPrompt, tools, dispatchTool, modelTier, maxToolRounds })
//   → async run({ task, context, threadHistory }) → { text, structured, toolTrace }
```

- `tools` / `dispatchTool`: passed straight into `generateReply` (same shape
  `respond.js` already builds for `TABLEAU_TOOL_SPECS`).
- `modelTier`: `"full"` for the specialist (heavy multi-join reasoning).
- `structured`: parsed from a fenced ```json block the specialist is prompted to
  emit alongside its prose (see §5). Kept separate from `text`.

### 4.2 Supervisor — `src/agents/supervisor.js` (NEW)

```js
// runSupervised({ userMessage, intents, context, ...session })
//   1. if !AGENTS_ENABLED  → getAiResponse(...)          // exact current behavior
//   2. if triage intent    → triageSpecialist.run(...)   // then compose reply
//   3. else                → getAiResponse(...)           // baseline for everything else
```

The supervisor is deliberately minimal for slice 1: **one** specialist, a clean
fallthrough to the baseline. It does *not* fan out to multiple specialists yet
(that's slice 2). "Interacts with the main MCP agent" is realized as: the
supervisor owns the main-agent context (Slack thread, user, locale) and the
specialist is invoked as a **sub-call** that returns a structured result the
supervisor composes into the final reply. This is deterministic and unit-testable
— preferred over free-form agent-to-agent messaging for the first slice.

### 4.3 Triage Specialist — `src/agents/triageSpecialist.js` (NEW)

- **Role prompt:** clinical operations analyst for nurse assignment. Knows the
  schema and joins (from the fixture README), the fan-out warning, the
  derived-column tautology rule, and that it must control for acuity and caveat
  small subgroups. It is told **nothing** about which effects are planted — it
  must discover them.
- **Tools:** the existing Tableau MCP query/metadata/list tools, plus one new
  purpose-built tool `triage_skill_gap` (§4.4). Scoped to the triage
  datasources.
- **Output contract:** prose (for Slack) + a fenced `json` structured block
  (for scoring & for the operational recommendation card). See §5.

### 4.4 New tool: `triage_skill_gap`

The skill-gap join (README §"Skill-gap analysis") is a fan-out trap if left to
free VizQL. Give the specialist a first-class tool that returns, for a patient or
an assignment, `{ required[], covered[], missing[], match_pct }` computed
correctly against the two bridge tables — so the specialist reasons over clean
input instead of risking an inflated aggregate. Lives beside the Tableau tool
specs in `src/assistant/tableauGeminiTools.js` or a new `src/agents/triageTools.js`.

## 5. Structured output contract

The specialist emits prose **and** a trailing fenced block:

````
```json
{
  "mode": "recommendation" | "analysis",
  "recommendation": {                     // when mode=recommendation
    "patient_id": "PT0123",
    "ranked_nurses": [
      { "nurse_id": "RN007", "skill_match_pct": 83.3, "workload_score": 2.0,
        "missing_skills": ["SK09"], "rationale": "…" }
    ],
    "unit_risk_delta": "…"
  },
  "findings": [                           // when mode=analysis (scoreable)
    { "effect": "ai_vs_manual_skill_match",
      "claim": "AI 75% vs Manual 33%", "magnitude": {"ai": 75.0, "manual": 33.1},
      "controlled_for": [], "confidence": "high" },
    { "effect": "skill_match_to_outcome",
      "claim": "…", "controlled_for": ["acuity"], "caveats": ["Moderate subgroup runs counter"] }
  ],
  "declined": ["night_shift_risk", "unit_x_dangerous"]   // traps it refused
}
```
````

Why structured: the fixture's BRIEF (backlog item 1) notes scoring is far easier
and more reliable when the agent emits structured claims than when a scorer parses
prose. We support **both** — prose stays human-facing in Slack; the JSON drives
the recommendation card and the eval harness. `declined` lets the scorer credit
*explicit* trap-refusal over mere silence (a rubric design choice, §7).

## 6. Evaluation harness

The fixture is fundamentally an eval fixture, so the slice is only meaningful with
scoring. The harness compares specialist output to `GROUND_TRUTH.md` **without ever
showing that file to the specialist**.

```
tests/eval/triage/            # QUARANTINE — answer key + scorer (already partly on disk)
  GROUND_TRUTH.md             # ✓ present — answer key (NEVER shown to the agent)
  manifest.json               # ✓ present — realized magnitudes (NEVER shown to the agent)
  FIXTURE-BRIEF.md            # ✓ present — fixture objective/backlog (eval-only)
  FIXTURE-README.md           # ✓ present — original README w/ planted-effects table (eval-only)
  README.md                   # ✓ present — the separation contract
  questions.json              # TODO — canonical analytical prompts (agent may see these)
  run-agent.js                # TODO — drives triageSpecialist, captures {prose, structured};
                              #        NEVER imports the answer-key files above
  score.js                    # TODO — loads GROUND_TRUTH.md + transcript → per-criterion grade
```

**Decision (locked):** scoring is **in-repo JS**, runs in `npm test`, so
multi-agent regressions are caught here. The fixture's own `score.py` (its backlog
item 1) can be built later for parity but is not on the critical path. Separation
is enforced by construction: `run-agent.js` and `score.js` are different entry
points; only `score.js` reads the answer key.

> **Scorer files must not match `tests/**/*.test.js`** (the `npm test` glob) — name
> them `run-agent.js` / `score.js` and invoke the scorer from a dedicated
> `*.test.js` (e.g. `tests/eval/triage/scorer.test.js`) that feeds it golden
> transcripts. The eval *run against the live agent* is a manual/CI-gated command,
> not part of the offline unit suite.

### Rubric (from `GROUND_TRUTH.md`, weights fixed by the fixture)

| Weight | Criterion | Scoring rule (proposed — needs sign-off) |
|---|---|---|
| 30% | Effect 1 (AI vs Manual skill match), right magnitude | hit if direction correct **and** both means within ±8 pts of {75.0, 33.1} |
| 30% | Effect 2 (skill match → outcome) **controlled for acuity** | full only if `controlled_for` includes acuity; **half credit** if effect found but not controlled |
| 15% | Effect 4 (comorbidity) without type-specific over-claim | hit if flat comorbidity effect claimed AND no per-type risk asserted |
| 15% | Avoids **all** traps | −(15/6) per trap reported; explicit `declined` scores ≥ silence |
| 10% | Caveats small subgroups (some n<20) | hit if any per-acuity subgroup caveat present |

Open tolerance/trap/partial-credit questions are surfaced in §11.

## 7. Data & deployment

- **Source of truth:** `triage_operations.twbx` (5 datasources, bundled CSVs).
  Bring the fixture into the repo under `demo-data/triage/` (mirrors
  `demo-data/vha/`), gitignoring nothing (it's SYNTHETIC by construction — every
  row carries `data_classification=SYNTHETIC`).
- **Publish to Tableau** so the MCP can reach it (same path as the VHA sources).
  The specialist queries it via the private-VPC MCP on AWS or the Heroku MCP.
- **Agent-facing view must exclude `patients.mean_skill_match_pct`** — it's the
  outcome model's own input, exposed only for validation (fixture backlog item 2;
  GROUND_TRUTH derived-columns table). Reading the effect off that column is a
  tautology, not a finding. Either publish a filtered datasource or have
  `triage_skill_gap`/prompt refuse to cite it.
- **`.twbx` not yet Tableau-parser-verified** (fixture CLAUDE.md known limitation)
  — open once in Desktop before relying on the published sources.

## 8. Feature flag & rollout

- `AGENTS_ENABLED` (default **off**). When off, `runSupervised` === today's
  `getAiResponse` byte-for-byte — zero risk to the live demo.
- Add to `.env.example`, the config-gate documentation, and Terraform
  `extra_env` / variables as an optional plain env var.
- Rollout: flag on in a dev workspace → run eval harness → compare specialist
  score vs. baseline (`getAiResponse` over the same questions) → only then
  consider default-on.

## 9. File-by-file change map

| File | Change |
|---|---|
| `src/agents/defineAgent.js` | NEW — role wrapper over `generateReply` |
| `src/agents/supervisor.js` | NEW — flag-gated dispatch; baseline fallthrough |
| `src/agents/triageSpecialist.js` | NEW — role prompt + tool wiring + output parse |
| `src/agents/triageTools.js` | NEW — `triage_skill_gap` tool + dispatch |
| `src/router/intentRouter.js` | ADD a `TRIAGE` intent signal (nurse/patient/assignment/acuity + admit); no existing behavior changed |
| `src/index.js` | Route through `runSupervised(...)` instead of calling `getAiResponse` directly (one-line swap in both handlers; supervisor calls the same fn when flag off) |
| `src/assistant/respond.js` | Export a reusable slice of prompt/context assembly if the specialist needs it; otherwise untouched |
| `.env.example` | ADD `AGENTS_ENABLED` |
| `demo-data/triage/` | ✓ DONE — agent-facing data (CSVs, `.twbx`) + neutral data dictionary |
| `tests/eval/triage/` | ✓ answer key quarantined; TODO `run-agent.js`, `score.js`, `questions.json`, `scorer.test.js` |
| `tests/agents/*.test.js` | NEW — unit tests (see §10) |

## 10. Test plan (offline, no live tenant)

- `defineAgent` runs a mocked `generateReply`, returns `{text, structured}`;
  structured JSON parse tolerates missing/garbled block.
- `supervisor` flag OFF → calls `getAiResponse` exactly (spy asserts args
  unchanged). Flag ON + triage intent → calls specialist. Flag ON + non-triage →
  baseline.
- `intentRouter` TRIAGE signal fires on scenario prompts, not on generic Tableau
  questions (guard against over-routing).
- `triage_skill_gap` computes required/covered/missing correctly on a small
  fixture slice; never fans out.
- Eval harness: `score.js` grades a hand-written **golden transcript** (a known
  good answer and a known bad/confabulating answer) to the expected bands —
  proves the scorer itself is correct before trusting it on the live agent.
- Full existing suite (183 tests) stays green with flag off.

## 11. Open design questions

**Resolved 2026-08-19:**

1. ~~Operational vs analytical first~~ → **Analysis mode first** (scoreable).
2. ~~Scorer home~~ → **In-repo JS**, runs in `npm test`.
6. ~~Specialist ↔ main agent coupling~~ → **Deterministic sub-call** for slice 1.
7. ~~Fixture into repo~~ → **Copied in** (done); Tableau publish + filtered
   (validation-aid-excluded) datasource **deferred** until a site is authorized.

**Resolved 2026-08-19 (scoring rules — now authoritative for `score.js`):**

3. **Tolerance band** → **±8 points**. Effect 1 is a hit if direction is correct
   (AI > Manual) AND both means fall within ±8 pts of {75.0, 33.1}.
4. **Trap scoring** → **explicit refusal scores higher than silence**. An agent
   that tested a trap and reported "no relationship" earns full trap credit; mere
   silence earns partial; reporting a trap as real is penalized either way.
   Concretely: per trap, `reported_as_real` = −(15/6); `declined` (in the
   structured `declined[]` or explicit prose) = full share; silent = half share.
5. **Partial credit** → **half**. Effect 2 found but not acuity-controlled = 15 of
   30 pts; full 30 only when `controlled_for` includes acuity.
8. **Specialist model** → **pinned to Sonnet 5** (`AGENT_TRIAGE_MODEL_ID`, default
   the Sonnet 5 id) for reproducible eval scores, independent of the app's
   `BEDROCK_MODEL_ID`. The baseline it's compared against uses the same pin so the
   comparison is apples-to-apples.

All scoring questions are now settled; `score.js` and the specialist role prompt
can be written to these rules at M2.

## 12. Milestones

1. **M1 — primitive + baseline parity:** ✓ DONE (2026-08-19). `src/agents/defineAgent.js`
   + `src/agents/supervisor.js`; `TRIAGE` intent added (inert with flag off);
   Bedrock per-agent model pin (`bedrockModelId`) threaded through `llmProvider`;
   both `index.js` call sites route through `runSupervised({...},{getAiResponse})`
   with **no specialist injected**, so the flag is behavior-neutral. `AGENTS_ENABLED`
   in `.env.example`. Tests: `tests/agents/supervisor.test.js`,
   `tests/agents/defineAgent.test.js`, TRIAGE cases in `tests/intentRouter.test.js`.
   Full suite **204/204 green** (was 183).
2. **M2 — triage analysis + recommendation specialist:** ✓ DONE (2026-08-19).
   - Data layer `src/agents/triageData.js` (reads `demo-data/triage/out` CSVs;
     strips the `mean_skill_match_pct` validation aid) + tools
     `src/agents/triageTools.js` (`triage_query` grouped aggregation,
     `triage_skill_gap` fan-out-safe, `triage_list_nurses_on_shift`) in Bedrock
     `{name,description,inputSchema}` shape. Verified the tools reproduce EVERY
     `GROUND_TRUTH` magnitude through the discovery path (AI 75.0 / Manual 33.1,
     adverse 17.1 / 27.9, all four per-acuity splits incl. the Moderate artefact).
   - Specialist `src/agents/triageSpecialist.js` (defineAgent instance; analysis +
     recommendation role prompt carrying methodology but **no** planted-effect
     knowledge — a regex test guards the prompt against the realized magnitudes;
     pinned via `AGENT_TRIAGE_MODEL_ID`). Reply composer
     `src/agents/composeTriageReply.js`. Both injected into `runSupervised` at
     both `index.js` call sites (still inert with the flag off).
   - Eval harness `tests/eval/triage/`: `questions.json`, `run-agent.js` (drives
     the agent; never imports the answer key — enforced by a lint test),
     `score.js` (grades per the locked rules: ±8-pt band, half-credit for
     uncontrolled effect 2, explicit-decline > silence for traps), and
     `scorer.test.js` golden good/bad transcripts. The golden GOOD test caught a
     real scorer bug (effect-1 finding bleeding into the effect-2 match) before it
     could mis-score a live run.
   - Full suite **236/236 green** (was 204). Live specialist-vs-baseline scoring is
     M4 (needs the pinned Sonnet 5 + published datasources).
3. **M3 — recommendation mode + Slack card:** ✓ DONE (2026-08-19). Operational
   "which nurse" surface in `#nurse-triage`: a secret-gated HTTP trigger
   `src/jobs/triageAdmissionTrigger.js` (`POST /triage/admission/<secret>`,
   `safeEqual` path secret, refuses to arm without the secret env, 404 on a bad
   secret, 409 when `AGENTS_ENABLED` is off, fast-ack 200 then background work,
   injectable handler for tests) → runs the specialist in recommendation mode and
   posts the ranked-nurse card via `client.chat.postMessage`. Wired in `index.js`
   (needs the Bolt `app`); `TRIAGE_ADMISSION_SECRET` / `TRIAGE_CHANNEL_ID` in
   `.env.example`. Tests: `tests/triageAdmissionTrigger.test.js` (6).
4. **M4 — publish datasources via Prep Agent skill + live run:** ✓ DONE (2026-08-20).
   - **M4a** MCP backend `src/agents/triageMcpData.js`: pre-fetches all 8 tables
     once per turn into `{table: rows[]}` and delegates to the UNCHANGED
     `dispatchTriageTool({tables})` — tools + prompt untouched. Selected at runtime
     by `resolveDispatchTool` (CSV default; Tableau MCP when `TRIAGE_MCP_DATASOURCES`
     is set; explicit override always wins).
   - **M4b/M4c** Published 8 passthrough datasources to Tableau Cloud `usfederaldemos`
     (project "50 - Nurse Triage Ops Demo") via the `tableau-prep-etl` skill, from a
     spec whose `patients` source is the FILTERED CSV (no `mean_skill_match_pct`).
     Invariant verified on the live DS: `patients` has 16 fields, forbidden column
     absent; belt-and-suspenders strip on read retained. See
     `[[triage-datasources-published]]` in memory for LUIDs + recipe.
   - **Two live-only bugs found & fixed during M4d** (the offline mock couldn't
     surface either): (1) `loadTablesFromMcp` fired all 8 fetches via `Promise.all`
     and collided on the single-PAT MCP session (concurrent Tableau signins
     terminate each other → only the race-winner returned rows) — now **sequential**;
     (2) `parseMetadataCaptions` didn't read the real Tableau v4 VDS
     `{fieldGroups:[{fields:[{name}]}]}` shape — now handled. Two regression tests
     added. Suite **263/263 green** (was 261).
   - **M4d live scoring** (pinned Sonnet 5, MCP-backed, real Bedrock): the specialist
     reproduced both planted effects exactly through the live datasources (AI 75.0 /
     Manual 33.1; adverse 17.1 / 27.9). **Specialist 87.5/100 vs single-call baseline
     17.5/100 (+70 pp).** HONEST read of the gap: 75 of the 100 points are the
     structured effect criteria, which the baseline auto-zeros because it emits **no
     `json` block** (it is the general Slack assistant, not contracted to) — its
     *prose* did find effect 1 (q1) and handle acuity confounding (q2), so the raw
     gap overstates pure analytic skill. Two findings are genuine, not scoring
     artefacts: the baseline lost the thread on the open-ended synthesis question
     (asked which catalog dataset was meant — it queries the whole tenant, not a
     scoped tool surface), and the **specialist over-claimed two planted nulls**
     (`unit_risk`, `age`) as real effects, scoring only 2.5/15 on traps vs the
     baseline's 7.5/15-by-silence. That over-claim is precisely the failure mode the
     deferred adversarial-Reviewer slice is meant to catch.

Later slices (separate docs): Reviewer adversarial gate (directly motivated by the
M4d trap over-claim above), Analyst/Writer split, channel-scoped personas, then the
event-driven/case-management primitives.
