# ARMOR 2.0 — Integrated Workforce & Readiness Demo — Design

**Status:** M0 (design) + **M1 (synthetic data, validator 20/20 green) complete.** M2 publish pending go-ahead. Target:
Full **Use Case 5** end-to-end, including the multi-agent flow (specialist + **adversarial
reviewer** + notifier).
**Runs on:** the Cohere **Mosaic** deploy (`pathfinder-mcp`, `AI_PROVIDER=cohere`,
`command-a-plus-05-2026`), sharing `federal-tableau-mcp`, published to `usfederaldemos`.
Parallel and non-destructive to the Claude bot (`damp-wave-30118`) **and** to the live VA
and SCRM verticals.

ARMOR ("Integrated Workforce and Readiness Platform") is a Defense Health Agency (DHA)
RFI illustration. The core problem is **fragmentation**: manpower (billets), credentialing
(privileging), medical clearance, and operational skillsets live in separate systems, so
leadership must manually reconcile *who is assigned* against *what they are authorized,
cleared, and ready to do*. This demo builds a **single integrated view** over a synthetic
star schema and lets the Mosaic agent answer the flagship question of **Use Case 5** — a
real-time "Net Assessment" of Military Treatment Facility (MTF) capacity, plus what-if
impact modeling and threshold alerting — in Slack, via the Tableau MCP tool loop.

This is the **third federal vertical** on the same playbook as VA (localized brief +
nurse-triage) and SCRM (risk brief + supplier-risk triage). It reuses that machinery
end-to-end; the new work is the ARMOR domain, the **capacity model**, and the **adversarial
reviewer** (which finishes the multi-agent pattern SCRM left pending).

---

## 0. Honest scope — what will and won't work

Read this first; it's the answer to "let me know what won't work."

**Works (demoable now, on the proven playbook):**
- A **single integrated view** across manpower / credentialing / clearance / skillset /
  facility — because we pre-join the domains into a clean star schema. This *illustrates*
  the vision the RFI asks for.
- **Net Assessment** — physical beds (MEPRS) cross-referenced against staff who are
  *assigned + credentialed + medically cleared + available*, per MTF × unit type.
- **What-if / impact modeling** — "if 5 ICU nurses are reassigned, MTF X loses 10 staffed
  ICU beds" — via a deterministic **capacity-model tool** (a staffing ratio per bed type),
  not VizQL alone.
- **Threshold alerting** — staffed capacity below a readiness threshold fires an alert to
  Slack, reusing the SCRM refresh-webhook → DM/channel path that is **already live**.

**Won't work / must be scoped honestly (these are demo caveats, stated up front):**
1. **No live system integration.** MHS GENESIS, MEPRS, DHMRSi, CCQAS are **not** connected.
   Tableau MCP reads *published synthetic extracts*, not operational feeds. Everything is
   SYNTHETIC.
2. **"Real-time" = latest published snapshot,** not a live feed. Our direct-upload
   datasources don't natively refresh (known gotcha), so freshness is "last publish /
   webhook fire."
3. **No write-back, no automated scheduling (UC4's core).** The agent is **advisory,
   human-in-the-loop, takes no action.** It *recommends and models* a reassignment; it does
   not execute one or push to a source system.
4. **Predictive = deterministic modeling, not statistical/ML forecasting.** The what-if is
   arithmetic on a staffing model with realistic ratios — not a trained predictor.
5. **We demonstrate the orchestration *surface*, not the ingestion/interoperability engine.**
   The hard part in reality (native interop across the source systems) is pre-solved in the
   fixture. Fine for an RFI illustration — call it illustrative.
6. **Scale limits.** Tableau MCP has a list-datasources truncation cap and tool-round limits
   (`COHERE_MAX_TOOL_ROUNDS=20`); a net-assessment fanning across many MTFs × unit types ×
   credential domains can strain rounds. We design around it with pre-aggregated derives.

---

## 1. What we mirror (VA / SCRM → ARMOR)

| VA / SCRM piece | ARMOR equivalent | File(s) reused |
|---|---|---|
| Facilities / Suppliers dimension | **MTFs** (Military Treatment Facilities) | `demo-data/armor/generate.js` |
| Metric / Risk registry | **Staffing model** (per unit type: ratio, required specialty + privilege, readiness threshold) | `armor_staffing_model.csv` |
| `*_snapshots` (date × entity × metric) | `armor_readiness_snapshots` (date × MTF × unit type → physical/staffed beds, status) | Pulse/alert source |
| Findings / action plans (+ injection) | **Taskings & notes** (proposed staffing changes + injection) | `armor_taskings.csv` |
| Localized brief (TRIGGER × ROLE × LOCATION/PORTFOLIO) | **Readiness brief** (TRIGGER × ROLE × SCOPE) | `src/jobs/scrmRiskBrief.js` → `armorReadinessBrief.js` |
| Refresh webhook | same, add ARMOR snapshots LUID | `src/jobs/scrmBriefRoutes.js` → `armorBriefRoutes.js` |
| Per-metric Tableau views | per-unit capacity views | `scrmRiskViews.js` → `armorReadinessViews.js` |
| Supplier-risk triage + eval | **capacity/readiness specialist + what-if + eval** | `src/agents/scrm*` → `armor*` |
| *(SCRM left pending)* adversarial reviewer | **built here** — gates the capacity verdict | `src/agents/armorReviewer.js` (new) |
| Admission/tasking trigger | **proposed-tasking event** → what-if → post | `triageAdmissionTrigger.js` → `armorTaskingTrigger.js` |

---

## 2. The synthetic data (M1 — DONE)

Deterministic generator `demo-data/armor/generate.js` (seed `20260929`, 18 months ending
**2026-08-31** — aligned with VA/SCRM latest month). Star schema of passthrough tables (no
Prep-time joins). Neutral dictionary `demo-data/armor/SCHEMA.md`; validator
`demo-data/armor/validate.js` (recomputes every planted effect, exit 0). One non-published
red-team fixture.

**Domains → tables** (each stands in for a named source system; each published as its own
passthrough datasource to protect grain):

| Table | Stands in for | Grain / key columns |
|---|---|---|
| `armor_facilities.csv` | MHS GENESIS org | MTF dimension: `mtf_id`, `mtf_name`, `market`, `region`, `command`, `sole_regional_role` (e.g. sole regional Burn center) |
| `armor_bed_capacity.csv` | Facility Mgmt / **MEPRS** | `mtf_id` × `unit_type` (ICU/Burn/Trauma/Med-Surg/ED/OR) → `physical_beds`, `square_footage`, `meprs_code` (baseline **physical** capacity) |
| `armor_billets.csv` | **DHMRSi** manpower | authorized positions: `billet_id`, `mtf_id`, `unit_type`, `specialty`, `required_grade`, `authorized=1` ("what's authorized") |
| `armor_personnel.csv` | MHS GENESIS HR | assigned people: `person_id`, `billet_id` (null = vacancy), `mtf_id`, `specialty`, `grade`, `availability_status` (on_station/deployed/TDY/leave) ("who's assigned") |
| `armor_credentials.csv` | **CCQAS** privileging | `person_id` × `privilege` (unit-type competency) → `privilege_status` (active/expiring/expired), `expiration_date` ("what they're authorized to do") |
| `armor_readiness.csv` | DHMRSi IMR + **JKSA** | `person_id` → `medical_clearance` (fully/partially/not), `imr_status`, `jksa_currency` (current/expiring/lapsed), `deployable` (Y/N) ("medically + operationally ready") |
| `armor_readiness_snapshots.csv` | Pulse / alert source | `period_month` × `mtf_id` × `unit_type` → `physical_beds`, `staffed_beds`, `readiness_threshold`, `rag_status`, + the **materialized alert layer** (below) |
| `armor_taskings.csv` | Surge / deployment plans | proposed & executed staffing changes: `tasking_id`, `mtf_id`, `unit_type`, `specialty`, `n_personnel`, `effective_date`, `status` (proposed/executed) + free-text note (the what-if & injection surface) |
| `armor_redteam_injection.csv` | — | **NEVER published**; raw prompt-injection kept out of the clean tasking notes |

**Materialized alert layer** on `armor_readiness_snapshots` (identical rules to VA/SCRM):
`as_of_date`, `prev_staffed`, `mom_delta`, `status_change`, `direction_of_change`, and the
trigger pair `alert_flag` / `alert_reason`. Fires on **change** (staffed beds crossing the
readiness threshold, or worsening), not standing state.

**The capacity model (source of truth = `armor_staffing_model.csv`, NOT a baked field):**
per `unit_type` → `beds_per_staff` (e.g. ICU RN = 2), `required_specialty`,
`required_privilege`, `readiness_threshold_beds`. Derived quantities are computed **by the
tool**, never stored as a circular column:
- `available_qualified_staff(mtf, unit)` = personnel assigned to that MTF whose specialty
  matches the unit, **privilege active**, **medically cleared**, and **available**.
- `staffed_beds(mtf, unit)` = `min(physical_beds, floor(available_qualified_staff ×
  beds_per_staff))` — the physical-bed cap matters and is a reviewer check.
- `readiness_status` = `staffed_beds` vs `readiness_threshold` → Green/Yellow/Red.
- `what_if(reassign N of specialty)` = `Δstaffed = -(N × beds_per_staff)` (floored at 0),
  new status, and surge-receiving impact.

### Planted effects & eval fixture

Doubles as a scoreable evaluation fixture — three planted effects verified by `validate.js`,
plus documented decoys. Answer key **quarantined** in `tests/eval/armor/`
(`GROUND_TRUTH.md`, `manifest.json`, `questions.json`); the agent under test sees only
`demo-data/armor/` (data + neutral dictionary) and `questions.json`.

- **E1 (primary — the manpower-vs-personnel gap, UC1):** authorized-vs-filled fill rate is
  uneven by specialty — **ICU/Critical-Care nursing filled ~78%** while Med-Surg ~96% — and
  of those filled, credential/clearance attrition **further** erodes ICU (a slice of ICU
  nurses carry expiring privileges or non-deployable IMR). Net: **true staffed ICU capacity
  sits well below what billets imply**, and it holds across MTFs (structural, not one site).
  The headline "manual reconciliation hides risk" insight.
- **E2 (interaction — the surge/criticality effect, the UC5 what-if):** a fixed reassignment
  degrades staffed beds **disproportionately at MTFs already near the credentialing margin**
  (interaction between current qualified-staff slack and tasking size). At the sole-regional
  **Burn** center a 5-nurse tasking crosses the readiness threshold *and* kills
  surge-receiving capacity; at a deep-bench MTF the same tasking stays Green. Partial credit
  if found without the margin/criticality control.
- **E3 (confounded / null trap):** "**larger facilities** (more physical beds / more square
  footage) **are more ready**" → **NULL / confounded**. Space is not the binding constraint —
  qualified staff is. Over-claiming "big MTF = ready" is the trap. Secondary trap: "high
  billet **authorization** = high readiness" (authorized ≠ filled ≠ qualified). Circular
  trap: an `overall_readiness_pct` precomputed roll-up **excluded** from published data
  (mirrors SCRM's `composite_risk_pct`) — never cite it.
- **Injection trap:** a prompt-injection embedded in one tasking note (sanitized in the clean
  file, raw in `armor_redteam_injection.csv`).

---

## 3. Demo A — readiness brief / net-assessment alert (Cohere)

Clone `src/jobs/scrmRiskBrief.js` → `src/jobs/armorReadinessBrief.js`, reframed to
**TRIGGER × ROLE × SCOPE**:

- **TRIGGER** — a proactive `alert_flag=true` scan OR a reactive Tableau
  `DatasourceRefreshSucceeded` webhook (add the `armor_readiness_snapshots` LUID to a new
  `isTriggeringRefresh`) OR a **proposed-tasking** event (Demo B trigger).
- **ROLE** — **MTF Commander** → all unit types at their MTF; **Unit / Service Chief** →
  their unit type; **DHA market / region lead** → all MTFs in market; **Manpower analyst** →
  billet-gap view. Resolved from the `armor_staffing_model` owning function + bindings
  (`ARMOR_BRIEF_BINDINGS`), reusing the SCRM role/scope resolver pattern.
- **SCOPE** (the location analog) — MTF + unit type + market. Bindings pin a user to an
  MTF/market + role.
- **Narration** — Command A Plus runs the MCP tool loop to compute the net assessment
  (physical vs staffed vs threshold, with the credential/clearance drill-down) and posts a
  brief (**status → why → recommended action**) to the owning channel / DM, with a per-unit
  capacity Tableau view (`armorReadinessViews.js`). Untrusted tasking text goes only in the
  injection-fenced `skillContext`.
- **Dedupe** — per-MTF-per-unit, reusing the `BriefDelivery` model (`briefDeliveryStore.js`),
  keyed `metric_key = mtf_id|unit_type`, `value = staffed_beds`.

---

## 4. Demo B — multi-agent UC5 (Cohere) — the flagship

Gated by `AGENTS_ENABLED` (default off). Clone the SCRM agent scaffold. **The adversarial
reviewer is in scope here** (it was the piece SCRM deferred).

- **Readiness / Capacity Specialist** (`src/agents/armorSpecialist.js`) — a `defineAgent()`
  instance on Command A Plus with two modes:
  - **assessment** — "current staffed capacity + gaps at MTF X," controlling for credential /
    clearance attrition, **distinguishing physical from staffed beds**, and reporting the
    null on square footage.
  - **impact / what-if** — "if N of specialty are reassigned from MTF X / unit U, what's the
    Δ staffed beds, the new readiness status, the surge-receiving impact, and the exposed
    mission?" Structured output contract like `scrmSpecialist` (`{mode, assessment[],
    whatif{}, declined[]}`).
- **Capacity-model tools** (`src/agents/armorTools.js`) — `armor_query`, `armor_capacity`
  (net assessment), `armor_whatif` (apply a tasking delta), `armor_facility_profile`.
  Deterministic; reproduce the planted effects exactly; CSV backend for offline eval, MCP
  backend when `ARMOR_MCP_DATASOURCES` is set (`armorMcpData.js`).
- **Adversarial Reviewer** (`src/agents/armorReviewer.js`, **new**) — a second agent that
  gates the specialist's output *before it posts*, checking for: (a) claiming a planted null
  is real (square footage / authorization → readiness); (b) **confusing physical with
  staffed beds** or ignoring the physical-bed cap; (c) over-stating "real-time"; (d) a claim
  not backed by a tool result; (e) CUI / injection leakage. Emits `{verdict: pass|revise,
  issues[]}`; on `revise` the specialist re-runs once with the issues, else the reviewer's
  caveat is appended. This is the roadmap's headline "checked by a second agent" feature.
- **Notifier** — posts a **Net Assessment card** to the ARMOR channel (open decision §10;
  proposed `#armor-readiness`) with the threshold-breach alert and a Block Kit
  `[Acknowledge][Assign][Escalate]` seam (case-management stub).
- **Trigger** (`src/jobs/armorTaskingTrigger.js`) — a "proposed tasking" HTTP event
  (analog of `triageAdmissionTrigger`): tasking payload → `armor_whatif` → reviewer → post
  impact. Gated by `AGENTS_ENABLED` + `ARMOR_TASKING_SECRET`.

**Eval:** `tests/eval/armor/{run-agent,score}.js` (clone of the SCRM scorer), run under
`node --test`. Specialist vs single-call baseline, and a **Cohere (Command A Plus) vs Claude
(Bedrock)** head-to-head on the same fixture (`AGENT_ARMOR_MODEL_ID` + `AI_PROVIDER=bedrock`).

---

## 5. Cohere-specific showcase

- **First multi-agent flow with an adversarial reviewer on Command A Plus** — the reviewer
  gating a governed federal readiness decision, live in Slack.
- **Head-to-head** Command A Plus vs Claude on the same planted-effect fixture, scored
  numerically.
- The what-if is where Command A Plus's tool loop shows value: fetch current state → apply
  the model → report impact, in one Slack turn (needs `COHERE_MAX_TOOL_ROUNDS=20`,
  `LLM_MAX_OUTPUT_TOKENS≥8192`; both already set on `pathfinder-mcp`).

---

## 6. Reuse vs. build

**Reuse (parameterize):** the `generate.js` / `validate.js` pattern, the `tableau-prep-etl`
publish recipe, `scrmBriefRoutes.js` / `tableauWebhook.js`, `briefDeliveryStore.js` /
`BriefDelivery`, the role/scope binding layer, `scrmRiskViews.js`, the
`defineAgent`/specialist/tools/mcpData scaffold, the SCRM eval `score.js` harness, the
`triageAdmissionTrigger.js` shape.
**Build new:** the ARMOR synthetic domain, the **capacity model** (`armor_staffing_model` +
the `armor_whatif` tool), the ARMOR prompts/rubric, and the **adversarial reviewer**.

---

## 7. Config / env (on `pathfinder-mcp`)

- `ARMOR_MCP_DATASOURCES` — JSON `{table: luid}` (captured at M2 publish).
- `ARMOR_BRIEF_BINDINGS` — JSON `[{email|slackId, mtf|market, role}]`.
- `ARMOR_TASKING_SECRET` — arms the proposed-tasking trigger.
- `ARMOR_CHANNEL_ID` — the readiness channel **ID** (not name).
- Reuse `TABLEAU_WEBHOOK_SECRET`, `SLACK_TEAM_ID`, `AGENTS_ENABLED=1`,
  `COHERE_MAX_TOOL_ROUNDS=20`, `LLM_MAX_OUTPUT_TOKENS`.
- Publish a **filtered** snapshots datasource (no `overall_readiness_pct`).

---

## 8. Carried-over gotchas

- Single Tableau PAT → fetch datasources **sequentially**, never `Promise.all`.
- VizQL **boolean filters need JSON `true`, not `"true"`** (`deployable`, `alert_flag`,
  `single_source`-style flags).
- Each table published as its **own passthrough datasource** (protect grain).
- Direct-`.hyper` upload has `hasExtracts:false` → native scheduled refresh won't fire the
  webhook → a **Heroku Scheduler scan** (or manual re-publish) is the reliable trigger.
- `im:write` comes from `SLACK_BOT_SCOPES`; reinstall via `/slack/install`.
- Injection sanitized out of the clean file; red-team file **never published**.

---

## 9. Milestones

- **M0 — design doc.** ✅ (this file)
- **M1 — generator + CSVs + validate + quarantined answer key** (`demo-data/armor/`,
  `tests/eval/armor/`). ✅ **DONE 2026-09-29** — 20/20 checks; ICU fill 80.9% vs Med-Surg
  98.6%; MTF-01 ICU 16→6 (Red) vs MTF-02 24→14 (Green) on a 5-nurse tasking; size r≈0.
- **M2 — publish** to `usfederaldemos` via `tableau-prep-etl` + live VizQL verification of
  every planted effect; capture `ARMOR_MCP_DATASOURCES`.
- **M3 — readiness brief on Cohere:** `armorReadinessBrief.js` + bindings + capacity views +
  webhook/scheduler; live DM test.
- **M4 — multi-agent UC5 (flagship):** capacity specialist + `armor_whatif` + **adversarial
  reviewer** + notifier + proposed-tasking trigger; `tests/eval/armor/score.js`;
  Cohere-vs-Bedrock scoring; live post to the ARMOR channel.
- **M5 (optional) — case management:** Block Kit `[Acknowledge][Assign][Escalate]` + case
  store.

---

## 10. Open decisions (surface before the relevant milestone)

- **ARMOR channel** for the multi-agent post — new `#armor-readiness`, or reuse an existing
  channel? (needs the channel **ID** + bot invited.)
- **M2 project name** on `usfederaldemos` (proposed "70 - DHA ARMOR Readiness Demo").
- **Scale of the fixture** — how many MTFs / unit types (proposed: ~10 MTFs, 6 unit types)
  to stay under Tableau MCP tool-round limits while still showing a multi-MTF market roll-up.
- **Staffing ratios** — confirm `beds_per_staff` per unit type (proposed ICU RN = 2, so the
  RFI's "5 nurses → 10 beds" holds exactly) and the readiness thresholds.
- **M4 scoring params** — magnitude tolerance bands and the partial-credit rule for E2
  (interaction found without the criticality/margin control).

---

## 11. Five-use-case coverage (RFI mapping)

| Use case | Fit | How this demo covers it | Caveat |
|---|---|---|---|
| **UC1 — Total Force Visibility (manpower vs. personnel reconciliation)** | ✅ core | Billets vs. filled vs. *qualified* (credential + clearance); **E1 is literally this** — the ICU fill-gap + attrition | Illustrative integrated view (pre-joined) |
| **UC2 — Joint Staff & Assured Operational Readiness (clinical)** | ✅ | `deployable` + JKSA currency + qualified clinical staff → readiness thresholds + tasking impact | Deterministic, not ML |
| **UC3 — Enterprise Visibility for Non-Clinical & Support** | ✅ (lighter) | Same model with non-clinical specialties/skillsets added to `armor_billets`/`personnel` | Add support specialties to the generator |
| **UC4 — Intelligent, Automated Workforce Scheduling & Compliance** | ⚠️ partial | We do the **compliance check** + a **schedule recommendation** (who's qualified/available) | **Automated scheduling / write-back = won't work** — advisory only |
| **UC5 — MTF Commander & Predictive Capacity Modeling** | ✅ flagship | Net Assessment + `armor_whatif` + threshold alert + multi-agent (specialist + reviewer) → Slack | "Real-time" = latest snapshot; predictive = deterministic model |

---

*Next: on your go-ahead, M2 — publish the nine tables to `usfederaldemos` (project
"70 - DHA ARMOR Readiness Demo") and live-verify every planted effect via VizQL.*
