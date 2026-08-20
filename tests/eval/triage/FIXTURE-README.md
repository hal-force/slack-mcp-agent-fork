# triage-synth

Synthetic hospital triage dataset generator, built as a test fixture for an
AI-assisted nurse assignment system analysed through the Tableau MCP server.

> **All output is synthetic.** No real patient, clinician, or facility data is
> represented. Every row of every table carries `data_classification=SYNTHETIC`.

**Working in this repo with an AI coding agent?** Read `BRIEF.md` for the
objective and backlog, then `CLAUDE.md` for the invariants. `BRIEF.md` ends with
a copy-pasteable kickoff prompt.

## Quick start

```bash
make all
```

That runs three steps:

```bash
python generate.py --seed 42 --out out   # CSVs + manifest.json + GROUND_TRUTH.md
python validate.py --data out            # 33 integrity/schema/coherence/power checks
python build_twbx.py --data out          # out/triage_operations.twbx
```

No third-party dependencies. Python 3.9+ standard library only.

## Why there is a GROUND_TRUTH.md

This dataset is not random noise. It contains **deliberately planted
statistical relationships** so that an analysis agent's output can be scored
against a known answer key rather than judged by impression.

`out/GROUND_TRUTH.md` is regenerated on every run and records:

- the effects the agent **should** recover, with the magnitudes actually
  realised in that sample
- the **traps** — plausible-looking relationships that are pure noise, which a
  well-calibrated agent should decline to report
- which columns are **derived**, so a tautological "finding" can be recognised
- any **sampling artefacts** in the current seed where a subgroup ran counter to
  the planted direction
- a suggested **scoring rubric**

Do not put `GROUND_TRUTH.md` in front of the agent under test.

## Planted effects

| # | Effect | Mechanism |
|---|---|---|
| 1 | AI-recommended assignments achieve higher skill match | Two genuinely different decision rules. AI scores five candidate nurses on skill match minus a workload penalty and takes the best; Manual takes the less loaded of two, ignoring skill fit. |
| 2 | Higher skill match reduces adverse outcomes | Explicit outcome model run *after* assignment, so the causal direction is real. |
| 3 | Higher skill match shortens length of stay | Weaker secondary effect, confounded by acuity on purpose. |
| 4 | Comorbidity raises adverse risk | Flat penalty, uniform across comorbidity type. |

Tune these in `src/config.py` under `PLANTED EFFECTS`. Changing them changes the
answer key — regenerate and re-read `GROUND_TRUTH.md`.

## Schema

| File | Rows (seed 42, approximate) | Grain |
|---|---|---|
| `patients.csv` | 900 | one per patient admission |
| `nurses.csv` | 20 | one per nurse |
| `nurse_skills.csv` | 112 | nurse x skill bridge |
| `patient_required_skills.csv` | ~2,000 | patient x required skill bridge |
| `assignments.csv` | ~1,650 | one per nurse-patient-shift |
| `unit_snapshots.csv` | 2,880 | one per unit per hour, 30 days |
| `clinical_notes.csv` | ~130 | one per note, ~40 patients |
| `skills_reference.csv` | 16 | skill taxonomy |

### Joins

```
assignments.patient_id            -> patients.patient_id
assignments.nurse_id              -> nurses.nurse_id
nurse_skills.nurse_id             -> nurses.nurse_id
nurse_skills.skill_id             -> skills_reference.skill_id
patient_required_skills.patient_id -> patients.patient_id
patient_required_skills.skill_id  -> skills_reference.skill_id
clinical_notes.patient_id         -> patients.patient_id
unit_snapshots.unit               -> nurses.home_unit
```

**Fan-out warning.** `assignments` joined to `patients` and `nurses` is
many-to-one and safe. Joining either *skills bridge* into that same view
multiplies rows and inflates every aggregate. Keep the bridges as separate
datasources, which is how `build_twbx.py` sets them up.

### Skill-gap analysis

`patient_required_skills` and `nurse_skills` are proper bridge tables. Skill gap
for an assignment is:

```sql
SELECT a.assignment_id,
       COUNT(DISTINCT prs.skill_id) AS required,
       COUNT(DISTINCT ns.skill_id)  AS covered
FROM assignments a
JOIN patient_required_skills prs ON prs.patient_id = a.patient_id
LEFT JOIN nurse_skills ns
       ON ns.nurse_id = a.nurse_id AND ns.skill_id = prs.skill_id
GROUP BY a.assignment_id;
```

`assignments.skill_match_pct` is this ratio precomputed.

## Clinical notes

Free-text records for ~40 patients: an H&P on admission, a progress note at
12-24h, and a discharge summary where the patient survived. Real newlines are
preserved.

Each note is internally consistent with the structured record — the stated age
and sex match `patients.csv`, the examination findings and plan come from the
patient's actual diagnosis, and the home medication list matches the documented
comorbidity. `validate.py` enforces all of this.

The comorbidity histories carry detail that does **not** exist in any structured
column: prior complications, discontinued drugs and why, imaging dates,
specialist follow-up intervals, adherence notes. This is the extraction target.
An agent that can determine from a note that a patient's anticoagulation was
recently held for a gastrointestinal bleed — and factor that into bleeding risk —
is doing something the structured data cannot support.

## Tableau workbook

`out/triage_operations.twbx` is self-contained; all CSVs are bundled. Five
datasources, six worksheets, two dashboards. Datetime columns are typed as
`datetime`, so date parts and continuous axes work without intervention.

The XML is well-formed and follows the documented Tableau 18.1 schema but has
**not** been validated by Tableau itself. Open it in Desktop once before relying
on it.

## Using this with an MCP analysis agent

Point the agent at the CSVs or the published datasource and ask questions that
require joins and judgement, not lookups:

- "Compare average skill match between AI-recommended and manual assignments."
- "Does skill match predict adverse outcomes? Control for acuity."
- "Which nurses are consistently assigned patients whose required skills they lack?"
- "Show unit risk over the last week and identify any staffing ratio breaches."
- "Read the clinical notes for the critical patients — is there anything in the
  histories that changes their risk profile beyond what the structured data shows?"

Then score the response against `GROUND_TRUTH.md`. A good agent recovers effects
1 and 2 with roughly correct magnitudes, controls for acuity, declines the
traps, and caveats the underpowered subgroups.

## Regenerating variants

```bash
python generate.py --seed 7 --patients 1200 --out out_large
python validate.py --data out_large
python build_twbx.py --data out_large
```

Every seed produces its own `GROUND_TRUTH.md` with that sample's realised
magnitudes. Raise `--patients` if `validate.py` warns about underpowered
subgroups.

The default of 900 patients was chosen empirically: at 600, effect 2 fell below
|z|=1.96 on roughly a third of seeds. `validate.py` will tell you if a given
seed is underpowered rather than letting you ship a fixture with no detectable
signal in it.
