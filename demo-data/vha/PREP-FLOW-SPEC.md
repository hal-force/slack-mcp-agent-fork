# Prep Agentic ETL — Flow Spec: VHA Tracker → Localized Metric Source

**Goal:** a Tableau Prep flow (built/run via the Prep Agentic ETL skill) that takes
the partner's raw action-plan tracker and produces the clean, metric-shaped data
source published to Tableau Cloud site **`canadianfederalonline`**, ready for Pulse
and for the Slack MCP agent.

**Status:** blueprint. The Prep Agentic ETL skill and Prep server endpoint are
**not yet loaded in this session** — once they are, this spec is the recipe to
execute. The synthetic outputs in this folder already represent the *expected
result* of the flow, so the flow can be validated against them.

> **Credential handling:** the Tableau PAT ("Slack Demo") is used **only as a
> runtime environment variable** at publish time and is **never written to any file
> in this repo**. Rotate it after the demo.

---

## Inputs

1. **`Action_Plans_Mock.csv`** — the raw partner tracker (operational action plans).
2. **`vha_metric_snapshots.csv`** — the synthetic monthly metric history (this repo).
   *(In a pure-synthetic demo the snapshots are generated, not derived from the
   tracker; the Prep flow's job for the tracker is the cleaning + join, and the
   snapshots are published alongside.)*

---

## Flow steps (raw tracker → clean `vha_action_plans`)

1. **Input** the raw tracker.
2. **Coalesce facility** — new field `facility_name = COALESCE([Facility (A-N)],
   [Facility (O-Z)])`. Trim whitespace. Drop the two split columns.
   → *This is the single most important cleaning step; the source split the name
   alphabetically across two columns.*
3. **Split location** — from `facility_name` derive `city` and `state`
   (`"Albany, NY HCS"` → city `Albany`, state `NY`). Keep `facility_name` as the
   canonical caption.
4. **Standardize metric** — map the free-text `Metric` to a controlled
   `metric_key` + `metric_caption` via the metric registry (fixes the tag/label
   drift in the source, e.g. a "flu vaccination" plan mis-tagged as a readmission
   metric → route to its true metric or mark `metric_key = UNMAPPED`).
5. **Reconcile status** (the "H5" data-quality traps) — compute a
   `data_quality_flag` when `Status` / `is_complete` / `Completed Date` disagree:
   - `Status = Done` but `is_complete = FALSE` or `Completed Date` is null → flag.
   - `is_complete = TRUE` but `Status ≠ Done` or `Completed Date` null → flag.
   Do **not** silently "correct" — surface the conflict so the agent/BI can show it.
6. **Sanitize free text** (`Progress Note`, `Comments`, `Barriers`) — strip any
   embedded instruction-injection strings (regex on
   `ignore (all )?previous|prior instructions`, `SYSTEM NOTE`, `authorized
   override`, etc.). Replace with a neutral marker and set
   `data_quality_flag = SANITIZED`. **Route the raw malicious value to a separate
   quarantine output**, not the published source. *(See `vha_redteam_injection.csv`
   for the one known case.)*
7. **Enrich** — join `vha_metric_registry` to attach `owning_channel`,
   `owning_function`, `target`, `direction`. Join `vha_facilities` to attach
   `visn`, `region`, `director`. Compute `latest_value` from the newest snapshot
   for that facility+metric.
8. **Type & name** — cast dates to date type; ensure every output field has a clean
   caption (no colons, no bilingual text) for MCP legibility.
9. **Outputs (published to `canadianfederalonline`):**
   - `vha_metric_snapshots` (the Pulse source)
   - `vha_action_plans` (cleaned)
   - `vha_facilities`, `vha_metric_registry` (dimensions)
   - **Quarantine** (NOT published): sanitized/injection rows.

---

## Publish targets on `canadianfederalonline`

- **Project:** `VHA Localized Metric Review (Demo)` *(create if absent)*.
- **Published data source name:** `VHA Metric Snapshots` (primary, for Pulse) with
  `VHA Action Plans` joined/related for the qualitative layer. Keep captions clean
  so `get-datasource-metadata` returns legible `fieldCaption`s.
- **Pulse:** one metric per `metric_key` (measure `value`, time `snapshot_date`,
  favorable direction from `direction`, drilldown `facility_name`/`visn`/`region`).

---

## Post-publish verification (via the Tableau MCP server the Slack agent uses)

1. `list-datasources` filtered to `name:eq:*VHA*` → confirm the sources appear.
2. `get-datasource-metadata` → confirm clean field captions (`value`, `target`,
   `facility_name`, `rag_status`, `assignee_function`, `owning_channel`).
3. `query-datasource` smoke test, e.g. `SUM(value)` grouped by `facility_name`
   filtered to latest month → returns real aggregates.
4. Add to the agent's approved catalog memory (caption-legibility fitness rule).

---

## Then: the localized metric agent + Slack subscription (design)

This is the build target the team agreed to (localized metric review over
proactive triage). Once the source is live:

1. **Daily Pulse digest / subscription per facility.** Schedule a daily job (Heroku
   Scheduler or a Slack workflow) that, per facility, reads the materialized
   **`alert_flag`** column — `true` only when this refresh brought a *change* worth
   attention (a new breach → Red, a fresh Green→Yellow warning, an escalation to a
   worse band, or a Red still worsening), carrying the human-readable `alert_reason`.
   This is the "trigger on the delta, not the level" behavior a Pulse metric wants,
   anchored on `as_of_date` (= `snapshot_date` + reporting lag = "the day the change
   was brought in"). It replaces reconstructing the flag from `rag_status` /
   `variance_to_target` / `mom_delta` at query time — those columns are still there
   for ranking and context. The shipped job `src/jobs/vhaLocalizedDigest.js` reads
   `alert_flag` directly (13 alerts in the latest seeded month).
2. **Trigger the MCP agent for the "so-what."** For each flagged metric, the agent
   is prompted with the facility + `assignee_function` + `region` context and:
   - queries the trend from `VHA Metric Snapshots` (last N months for that
     facility+metric),
   - pulls the linked `vha_action_plans` (status, barriers, progress, escalation),
     benchmarks vs `visn_median` / `national_median`,
   - synthesizes a short **"what changed, why, and what's being done"** narrative,
   - posts it to the metric's `owning_channel`, addressed to the owning function.
3. **Localized filtering (Arthur's ask).** The agent shows a facility admin **only
   their facility's** relevant metrics — corporate metrics filtered to
   `facility_name` (+ VISN peer context), keyed on the user's function/location.
4. **Security demo.** Run the `vha_redteam_injection` fixture through the same path
   to show the agent fencing the injection (summarize the plan; refuse the "post to
   #general" override).

**Suggested first channels:** `#vha-quality`, `#vha-care-trans`, `#vha-access`,
`#vha-vex` (already the metric owners in the registry), plus a per-facility channel
convention like `#vha-albany` for the localized digest.
