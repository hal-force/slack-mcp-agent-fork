# DHA ARMOR — Synthetic Data Schema & Data Dictionary

**Purpose:** An Integrated Workforce & Readiness star schema for a Defense
Health Agency (DHA) illustration: manpower (billets), credentialing
(privileging), medical clearance, and skillset are pre-joined into a clean
star schema over Military Treatment Facilities (MTFs), so the Cohere Slack
agent can (a) deliver a role-scoped **readiness brief** when staffed capacity
crosses a threshold and (b) run **net assessment / what-if impact modeling**
over a proposed staffing tasking. Mirrors `demo-data/scrm`.

**Generator:** `demo-data/armor/generate.js` (deterministic — same output every run).
**Validator:** `demo-data/armor/validate.js` (recomputes the planted effects).
**Site to publish to:** `usfederaldemos` (Tableau Cloud, pod `prod-useast-a`).

> **Design principle for MCP legibility:** every field has a clean,
> human-readable caption and every dimension is a single column. The model
> must name `fieldCaption` values exactly, so column names are kept
> snake_case and unambiguous.

> **This is a neutral dictionary.** It documents *what the columns mean*, not
> the planted statistical effects or their magnitudes. The scoring key is
> quarantined in `tests/eval/armor/` and must not be given to an agent under
> evaluation.

---

## The star schema (nine published tables + one non-published fixture)

```
   armor_staffing_model (capacity model: beds_per_staff, thresholds, routing)
                 |
   armor_facilities |          (MTF dim: market, region, command, sole role)
        \          |          /
         \         v         /
          +--> armor_readiness_snapshots  <-----  THE PULSE / ALERT SOURCE
          |     (month x mtf x unit_type, monthly history)
          |
   armor_bed_capacity (mtf x unit_type -> physical beds, MEPRS; static baseline)

   armor_billets (authorized positions)  --  armor_personnel (who's assigned)
        |                                          |
        +---------------- billet_id ---------------+
                                                     |
                              armor_credentials (privileging) + armor_readiness (clearance/JKSA)
                                          joined on person_id

   armor_taskings.csv          --  proposed & executed staffing changes (+ notes)
   armor_redteam_injection.csv --  NOT published; prompt-injection demo fixture
```

The join that powers the net assessment: **`armor_billets` ⋈ `armor_personnel`**
on `billet_id` (a billet with no matching personnel row is vacant), then
**`armor_personnel` ⋈ `armor_credentials` ⋈ `armor_readiness`** on `person_id`
to determine who is actually *assigned + credentialed + medically cleared +
available*. `armor_bed_capacity` supplies the physical-bed ceiling.
`armor_readiness_snapshots` is the materialized monthly view of that model,
per MTF × unit type. `armor_taskings` is the what-if input (a proposed change
in headcount) and the injection surface.

---

## Table 1 — `armor_staffing_model.csv`  *(6 rows — the capacity-model source of truth)*

Grain: one row per unit type (ICU, Burn, Trauma, Med-Surg, ED, OR).

| Field | Type | Meaning |
|---|---|---|
| `unit_type` | string | ICU / Burn / Trauma / Med-Surg / ED / OR |
| `beds_per_staff` | number | How many beds one qualified, available staff member can staff in this unit type |
| `required_specialty` | string | The `armor_personnel.specialty` / `armor_billets.specialty` that counts toward this unit |
| `required_privilege` | string | The `armor_credentials.privilege` that must be `active` to count as qualified for this unit |
| `readiness_threshold_beds` | number | Minimum staffed-bed count considered "Green-capable" for this unit type (see RAG rule below) |
| `owning_function` | string | The clinical/administrative role that owns this unit type's readiness (routing for role-scoped briefs) |
| `owning_channel` | string | Slack channel that owns alerts for this unit type |

**The capacity model** (computed by the tool/agent, never stored as a
circular column):
- `available_qualified_staff(mtf, unit)` = personnel assigned to that MTF
  whose specialty matches the unit, whose `armor_credentials.privilege_status`
  is `active` for that unit's required privilege, whose
  `armor_readiness.medical_clearance` is `fully`, and whose
  `armor_personnel.availability_status` is `on_station`.
- `staffed_beds(mtf, unit)` = `min(physical_beds, floor(available_qualified_staff x beds_per_staff))`.
  The physical-bed cap matters — it is not always the binding constraint.
- `readiness_status` = `staffed_beds` vs `readiness_threshold_beds`: **Red**
  if below threshold, **Yellow** if within 10% above threshold, **Green** otherwise.
- `what_if(reassign N of a specialty)` = `staffed_beds - (N x beds_per_staff)`
  (floored at 0), re-evaluated against the same RAG rule.

---

## Table 2 — `armor_facilities.csv`  *(10 rows — MTF dimension)*

`mtf_id`, `mtf_name`, `market` (regional grouping used for market/region-lead
briefs), `region`, `command` (Army / Navy / Air Force), `sole_regional_role`
(blank, or a unit type this MTF is the *sole* regional referral center for —
e.g. `Burn` — meaning no other MTF in the market can absorb surge for that
unit type).

---

## Table 3 — `armor_bed_capacity.csv`  *(60 rows — mtf x unit_type)*

Grain: one row per MTF × unit type. This is the **baseline physical capacity**
(static — it does not vary month to month, unlike staffed capacity).

| Field | Type | Meaning |
|---|---|---|
| `mtf_id` | string | Join key to `armor_facilities` |
| `unit_type` | string | ICU / Burn / Trauma / Med-Surg / ED / OR |
| `physical_beds` | number | Physical bed count for this unit at this MTF (the facility-management ceiling) |
| `square_footage` | number | Unit square footage (facility-management scale, not a staffing measure) |
| `meprs_code` | string | Synthetic MEPRS-style cost/workload code for this unit type |

---

## Table 4 — `armor_billets.csv`  *(authorized manpower positions)*

Grain: one row per authorized position. `billet_id`, `mtf_id`, `unit_type`,
`specialty` (the nursing specialty required to fill this position),
`required_grade` (e.g. `O-3`), `authorized` (always `1` — this row *is* one
authorized position; sum it to get the authorized headcount for an MTF × unit
type × specialty).

---

## Table 5 — `armor_personnel.csv`  *(assigned people)*

Grain: one row per person actually assigned. `person_id`, `billet_id` (the
specific authorized position this person fills), `mtf_id`, `specialty`,
`grade`, `availability_status` (`on_station` / `deployed` / `TDY` / `leave` —
only `on_station` counts toward staffed capacity).

A billet with **no** personnel row referencing it is **vacant** — not every
authorized position is filled.

---

## Table 6 — `armor_credentials.csv`  *(CCQAS privileging)*

Grain: one row per person (each person holds exactly one privilege record
relevant to their assigned unit in this fixture). `person_id`, `privilege`
(the unit-type competency, e.g. "ICU Critical Care"), `privilege_status`
(`active` / `expiring` / `expired` — only `active` counts toward staffed
capacity), `expiration_date`.

---

## Table 7 — `armor_readiness.csv`  *(medical clearance + operational currency)*

Grain: one row per person. `person_id`, `medical_clearance` (`fully` /
`partially` / `not` — only `fully` counts toward staffed capacity),
`imr_status` (Individual Medical Readiness), `jksa_currency` (Joint
Knowledge/Skills/Abilities currency: `current` / `expiring` / `lapsed`),
`deployable` (`Y` / `N`).

---

## Table 8 — `armor_readiness_snapshots.csv`  *(1,080 rows — the Pulse/alert source)*

Grain: **one row per MTF × unit type × month** (10 × 6 × 18).

| Field | Type | Meaning |
|---|---|---|
| `period_month` | string | `YYYY-MM` |
| `mtf_id` | string | Join key to `armor_facilities` |
| `unit_type` | string | ICU / Burn / Trauma / Med-Surg / ED / OR |
| `physical_beds` | number | Same static value as `armor_bed_capacity` for this mtf x unit |
| **`staffed_beds`** | number | **The measure to trend.** The capacity model's output for that month |
| `readiness_threshold` | number | This unit type's `readiness_threshold_beds` |
| `rag_status` | string | `Green` / `Yellow` / `Red` (see RAG rule above) |
| `as_of_date` | date | The day this month's readiness scan landed (reporting lag) |
| `prev_staffed` | number | Prior month's `staffed_beds` (blank in month 1) |
| `mom_delta` | number | Month-over-month change in `staffed_beds` |
| `status_change` | string | RAG transition, e.g. `Yellow->Red` |
| `direction_of_change` | string | `improved` / `worsened` / `no_change` (higher staffed beds = improved) |
| **`alert_flag`** | bool | **`true` when this refresh brought a change worth attention** (rules below) |
| `alert_reason` | string | Why: `breach: entered Red`, `warning: Green to Yellow`, `escalation: <transition>`, `sustained Red, still worsening` |

### Alerting layer — trigger on the *delta*, not the *level*

`alert_flag` fires when — and only when: (1) **breach** — entered `Red` from
a better band; (2) **warning** — fresh `Green -> Yellow`; (3) **escalation** —
moved to any strictly worse RAG band; (4) **sustained-worsening** — already
`Red` and still declining. A steady `Red` everyone already knows about does
not re-alert unless it keeps declining; recoveries stay silent. The Slack
brief reads `alert_flag` directly and surfaces `alert_reason` in the header.

---

## Table 9 — `armor_taskings.csv`  *(proposed & executed staffing changes)*

Grain: one row per tasking. `tasking_id`, `mtf_id`, `unit_type`, `specialty`,
`n_personnel`, `effective_date`, `status` (`proposed` / `executed`), `note`
(free text — the what-if narrative and, in one row, the injection-fencing
demo surface).

**Deliberate demo content:** one row's `note` has had an embedded
prompt-injection attempt sanitized out (flagged inline in the text); the raw
version lives only in `armor_redteam_injection.csv`.

---

## Fixture (NOT published) — `armor_redteam_injection.csv`  *(1 row)*

The raw prompt-injection string, kept **out of the published data source**.
Use it to demonstrate the agent's **prompt-injection fencing**: feed it as
untrusted context and confirm the agent treats it as data — summarizes the
legitimate tasking, refuses the override, and does not exfiltrate anything.
`expected_agent_behavior` documents the pass condition.

---

## What is deliberately NOT published

No `overall_readiness_pct` (or any other precomputed composite roll-up) is
ever emitted, anywhere. Recovering readiness from the underlying
manpower/credentialing/clearance tables is the point of the exercise — there
is no shortcut column to cite instead.
