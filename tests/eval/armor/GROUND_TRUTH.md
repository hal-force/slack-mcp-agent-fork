# GROUND TRUTH — scoring key for ARMOR agent evaluation

**Dataset version:** 1.0.0
**Seed:** 20260929
**Latest month:** 2026-08-31
**Classification:** SYNTHETIC

> Do not give this file to the agent under test. It is the answer key. It
> lives in `tests/eval/armor/` (quarantine); the agent sees only
> `demo-data/armor/` (data + a neutral dictionary) and
> `tests/eval/armor/questions.json` (the questions).

This dataset carries **deliberately planted effects** in its capacity model.
An analysis agent working the CSVs (or the live Tableau datasources) should
recover them. The tables below record the effects as realized in this seed,
so agent output can be scored numerically. All magnitudes are measured on the
**latest month (2026-08-31)** by `demo-data/armor/validate.js`, which
independently recomputes every number from the raw `armor_billets` /
`armor_personnel` / `armor_credentials` / `armor_readiness` /
`armor_bed_capacity` tables — never from a baked column.

---

## Findings the agent SHOULD recover

### 1. ICU/Critical-Care nursing fill rate lags Med-Surg, and credential/clearance attrition erodes ICU further (the manpower-vs-personnel gap, UC1)

| | Authorized | Filled | Fill rate | Qualified (post-attrition) | Qualified % of authorized | Erosion among filled |
|---|---|---|---|---|---|---|
| **ICU / Critical Care** | 94 | 76 | **80.9%** | 66 | **70.2%** | **13.2%** |
| **Med-Surg** | 73 | 72 | **98.6%** | 71 | 97.3% | 1.4% |

The fill-rate gap (Med-Surg − ICU) is **+17.7 points**. Of ICU nurses who
*are* assigned, **13.2%** are further disqualified — expiring/expired
privileges, medical clearance not `fully`, or not `on_station` — versus only
**1.4%** for Med-Surg. Net effect: **true available ICU capacity (70.2% of
authorized) sits well below what billets alone imply (80.9% filled)**, and
the direction (ICU fill below Med-Surg fill) holds at **9 of 10 MTFs** that
have both units — this is structural, not one site's problem. This is the
"manual reconciliation across DHMRSi/CCQAS/IMR hides risk" headline (UC1).

An agent that reports only the 80.9% fill rate and stops has found half the
finding; the erosion layer (qualified 70.2%, not 80.9%) is the deeper,
non-obvious part.

### 2. A fixed 5-nurse reassignment tips the sole-regional Burn center into Red, but the same reassignment leaves a deep-bench MTF Green (the surge/criticality interaction, the UC5 what-if)

ICU `beds_per_staff = 2`, so reassigning 5 nurses removes exactly **10
staffed beds**. ICU `readiness_threshold_beds = 8`.

| MTF | Staffed ICU beds now | RAG now | Staffed ICU beds after −10 | RAG after |
|---|---|---|---|---|
| **MTF-01 — Cedarview Naval Medical Center** (sole-regional Burn center) | 16 | Green | **6** | **Red** |
| **MTF-02 — Ironwood Regional Medical Center** (deep bench) | 24 | Green | 14 | Green |

Both MTFs look identically "Green" today and neither is authorized-billet-
starved — the difference only shows up when you model the tasking. Cedarview
has 8 beds of slack above threshold (16 − 8); Ironwood has 16 beds of slack
(24 − 8). The **same** −10-bed delta consumes all of Cedarview's slack and
crosses it into Red — and because Cedarview is the *sole* regional Burn
referral center, there is no other MTF in its market to absorb burn-surge
demand while its ICU is degraded. Ironwood's larger margin absorbs the same
delta with beds to spare.

An agent that computes the −10-bed arithmetic correctly for *one* MTF but
does not contrast it against a deep-bench MTF, or does not note the
sole-regional-role compounding factor, has found the mechanism but not the
full interaction. **Credit partial** in that case.

---

## Findings the agent should NOT report (traps)

| Trap | Why it's wrong |
|---|---|
| "Bigger MTFs (more physical beds) are more staffing-ready" | Physical beds are drawn independently of the qualified-staff pipeline; controlling for unit type (an ICU and a Med-Surg ward are not comparable in raw bed count), the correlation between physical beds and the staffed/physical ratio is **r = −0.07** — noise. |
| "More square footage means more ready" | Same null: **r = 0.00** once unit type is controlled for. |
| "MTFs with more authorized ICU/unit billets are more ready" | Authorization ≠ fill ≠ qualified. Correlation between authorized-billet count and the staffed/physical ratio (unit-type-controlled): **r = 0.39** — weak, and driven by the same MTFs that happen to also fill well, not by authorization itself. Do not report authorization level as a driver of readiness. |
| "`overall_readiness_pct` (or any composite score) tells you readiness" | **No such column exists in any published table.** There is no shortcut — readiness must be recovered from billets/personnel/credentials/readiness/bed_capacity. An agent that references a composite readiness percentage is hallucinating a column. |

---

## Derived vs observed columns

| Column | Status |
|---|---|
| `armor_readiness_snapshots.staffed_beds` | **Derived** — `min(physical_beds, floor(available_qualified_staff x beds_per_staff))`, recomputed from `armor_billets`/`armor_personnel`/`armor_credentials`/`armor_readiness`/`armor_bed_capacity`. The latest month's value is guaranteed (validated) to equal that recomputation exactly. |
| `armor_readiness_snapshots.rag_status` | Derived: threshold + 10% yellow band applied to `staffed_beds` |
| `armor_readiness_snapshots.alert_flag` / `alert_reason` | Derived from the month-over-month RAG transition |
| *(no composite/roll-up column exists anywhere)* | By design — see traps above |

---

## Suggested scoring rubric

| Weight | Criterion |
|---|---|
| 30% | Recovers effect 1 (ICU fill-rate gap vs Med-Surg) **and** the deeper credential/clearance erosion layer (qualified % well below fill %), and notes it holds structurally across MTFs |
| 30% | Recovers effect 2 (the burn-center-vs-deep-bench −10-bed what-if) **and** identifies the criticality/margin interaction — i.e., contrasts the two MTFs, not just one (partial credit if only one MTF is modeled) |
| 20% | Avoids all traps above (facility size, square footage, billet authorization, and not inventing a composite readiness column) |
| 10% | Correctly distinguishes physical beds from staffed beds throughout (never conflates "10 physical beds" with "10 staffed beds") |
| 10% | Caveats appropriately (e.g., small subgroup sizes, "real-time" = latest snapshot not a live feed, advisory-only framing for any recommendation) |
