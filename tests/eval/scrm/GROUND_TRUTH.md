# GROUND TRUTH — scoring key for SCRM agent evaluation

**Dataset version:** 1.0.0
**Seed:** 20260924
**Latest month:** 2026-08-31
**Classification:** SYNTHETIC

> Do not give this file to the agent under test. It is the answer key. It lives in
> `tests/eval/scrm/` (quarantine); the agent sees only `demo-data/scrm/` (data + a
> neutral dictionary) and `tests/eval/scrm/questions.json` (the questions).

This dataset carries **deliberately planted statistical effects**. An analysis
agent working the CSVs (or the live Tableau datasources) should recover them. The
tables below record the effects as realized in this seed, so agent output can be
scored numerically. All magnitudes are measured on the **latest month
(2026-08-31)** by `demo-data/scrm/validate.js`.

---

## Findings the agent SHOULD recover

### 1. FOCI-flagged suppliers carry far higher cyber and prohibited-source risk — and it holds within sector

`foci_flag` is assigned **independently of sector**, and the risk model adds a flat
bump to `CYBER` (+30) and `PROHIBITED_SRC` (+42) for FOCI suppliers. The recoverable,
non-tautological finding is the **cross-KRI** link (FOCI status → cyber/compliance
risk), not the fact that FOCI suppliers score high on the FOCI KRI itself
(definitional).

| KRI (latest-month mean risk score) | FOCI (n=12) | Non-FOCI (n=28) | Gap |
|---|---|---|---|
| CYBER | **70.1** | **30.8** | +39.3 |
| PROHIBITED_SRC | **66.4** | **15.8** | +50.6 |

**Holds within sector:** in all **9** sectors that contain both FOCI and non-FOCI
suppliers, the FOCI cohort's mean CYBER score is higher — so the effect is not a
sector confound. An agent that reports the aggregate gap **and** confirms it
survives a sector control is reasoning correctly.

### 2. Single-source geographic concentration raises delivery risk — but only for Mission-Critical suppliers (interaction)

`ss_concentrated` (a supplier with ≥2 single-source components sourced from a
concentrated region — China/Taiwan in this fixture) adds +34 to `DELIVERY`, but
**only when the supplier is Mission-Critical**. Non-Mission-Critical suppliers get
no concentration bump, so the effect is an **interaction with criticality**, not a
main effect.

| DELIVERY mean risk score | Single-source-concentrated | Not concentrated | Gap |
|---|---|---|---|
| **Mission-Critical** | **67.6** (n=8) | **31.7** (n=2) | **+35.9** |
| Not Mission-Critical | 38.9 (n=6) | 29.7 (n=24) | +9.2 |

The Mission-Critical gap (+35.9) is real and large; the non-MC gap (+9.2) is small
and driven by the financial confound below, not by concentration. An agent that
reports the concentration→delivery link **without** noticing the interaction with
criticality has found a real signal but drawn a weaker inference. **Credit partial.**

> Caveat to expect from a good agent: `n_mc_not = 2` is a very small subgroup. An
> agent that flags the thin cell rather than over-trusting the 31.7 figure is
> reasoning well.

### 3. Financially distressed suppliers show elevated delivery risk (real, but confounded — secondary)

The model couples `FINANCIAL` into `DELIVERY` (+0.35 per point of financial-distress
center above 45). Realized correlation across suppliers (latest month):

| Relationship | Pearson r |
|---|---|
| FINANCIAL vs DELIVERY | **0.76** |

This is a genuine association, but it is **confounded** — financially distressed
suppliers in this fixture also skew toward the deteriorating archetype. An agent
that reports the correlation as a real coupling **without** claiming clean causation,
and notes the confound, is correct. Claiming "financial distress causes delivery
failure" as established is over-reading.

---

## Findings the agent should NOT report (traps)

| Trap | Why it's wrong |
|---|---|
| "Small-business suppliers are riskier" | `small_business` is assigned independently and feeds no risk score. Mean composite: small-business **38.3** vs non **34.5** (gap 3.8 — noise). |
| "Older / longer-established suppliers are riskier" | `established_year` touches nothing downstream. Correlation with composite risk: **r = −0.01**. |
| "Suppliers with more contracts are riskier" | `contract_count` is drawn independently of risk. Correlation with composite risk: **r = 0.15** (noise; do not report as a driver). |
| "`composite_risk_pct` predicts / explains supplier risk" | True but **circular** — it is a weighted mean of the very KRI scores the agent is asked to analyze, exposed on `scrm_suppliers.csv` as a validation aid. Recovering risk from the snapshots is the real finding; reading `composite_risk_pct` is not. |
| "Country of ownership drives cyber risk (independent of FOCI)" | Cyber elevation tracks the `foci_flag`, not country per se. Attributing it to a specific country beyond the FOCI mechanism is over-reading. |

---

## Derived vs observed columns

An agent "discovering" a relationship between a derived column and its own inputs
has found a tautology.

| Column | Status |
|---|---|
| `scrm_suppliers.composite_risk_pct` | **Derived** (weighted mean of latest-month KRI scores). **Validation aid — exclude from agent-facing analysis; do not cite.** |
| `scrm_risk_snapshots.rag_status` | Derived: threshold + yellow band applied to `risk_score` |
| `scrm_risk_snapshots.variance_to_threshold` / `pct_to_threshold` | Derived from `risk_score` and `threshold` |
| `scrm_risk_snapshots.alert_flag` / `alert_reason` | Derived from the month-over-month RAG transition |
| `scrm_risk_snapshots.*_median` / `vs_*_median` | Derived peer benchmarks |

---

## Suggested scoring rubric

| Weight | Criterion |
|---|---|
| 30% | Recovers effect 1 (FOCI → cyber & prohibited-source) with roughly correct magnitude **and** confirms it holds within sector |
| 25% | Recovers effect 2 (single-source concentration → delivery) **and** identifies the Mission-Critical interaction (partial credit if found without the criticality control) |
| 15% | Recovers effect 3 (financial → delivery) as a real-but-confounded association, without over-claiming causation |
| 20% | Avoids all traps above (small-business, established-year, contract-count, and the `composite_risk_pct` circularity) |
| 10% | Caveats thin subgroups (especially `n_mc_not = 2`) and does not lean on `composite_risk_pct` |
