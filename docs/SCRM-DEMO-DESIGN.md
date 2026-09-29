# Public-Sector SCRM Demo — Design

**Status:** M0 (design) + M1 (synthetic data) + **M2 (publish + live verification) complete.** M3–M4 pending user go-ahead.
**Runs on:** the Cohere Mosaic deploy (`pathfinder-mcp`, `AI_PROVIDER=cohere`,
`command-a-plus-05-2026`), sharing `federal-tableau-mcp`, published to
`usfederaldemos`. Parallel and non-destructive to the Claude bot (`damp-wave-30118`).

This mirrors the VA build (localized metric brief + nurse-triage multi-agent) for a
**Supply-Chain Risk Management** story, and is the first showcase of Cohere Command A
Plus driving the agentic Tableau MCP tool loop and a multi-agent flow (unblocked by
the `generateWithCohere` tool loop shipped this session).

---

## 1. What we mirror (VA → SCRM)

| VA piece | SCRM equivalent | File(s) reused |
|---|---|---|
| Facilities dimension | **Suppliers** dimension | `demo-data/scrm/generate.js` |
| Metric registry (6 KRIs, target/dir/channel/function) | **Risk registry** (7 KRIs, NIST SP 800-161) | `scrm_risk_registry.csv` |
| `vha_metric_snapshots` (date×facility×metric) | `scrm_risk_snapshots` (date×supplier×KRI) | Pulse/alert source |
| Action plans (qualitative + injection) | **Risk findings** (+ injection) | `scrm_findings.csv` |
| Localized daily brief (TRIGGER × POSITION × LOCATION) | **Risk brief** (TRIGGER × ROLE × PORTFOLIO) | `src/jobs/vhaDailyBrief.js` → `scrmRiskBrief.js` |
| Refresh webhook | same, add SCRM snapshots LUID | `src/jobs/tableauWebhook.js` |
| Per-metric Tableau views | per-KRI risk-trend views | `src/jobs/vhaMetricViews.js` → `scrmRiskViews.js` |
| Nurse-triage multi-agent + eval | supplier-risk triage + eval | `src/agents/*`, `tests/eval/triage/*` |

---

## 2. The synthetic data (M1 — DONE)

Deterministic generator `demo-data/scrm/generate.js` (seed `20260924`, 18 months
ending **2026-08-31**). Six published tables + one non-published red-team fixture; a
star schema of passthrough tables (no Prep-time joins). Full dictionary:
`demo-data/scrm/SCHEMA.md`.

**7 KRIs** (all scored 0–100, higher = more risk), each with a threshold, a Yellow
band, and an owning Slack channel + analyst function:

| KRI | threshold | owning function |
|---|---|---|
| FOCI (Foreign Ownership, Control & Influence) | 30 | Foreign Influence Analyst |
| PROHIBITED_SRC (Sec. 889 / OFAC / SAM) | 20 | Compliance Analyst |
| CYBER (CMMC / incidents / CVEs) | 35 | Cyber SCRM Analyst |
| FINANCIAL (distress) | 40 | Acquisition Analyst |
| DELIVERY (schedule / OTD) | 30 | Logistics Analyst |
| CONCENTRATION (single-source / geographic) | 35 | Portfolio Manager |
| AUTHENTICITY (counterfeit / provenance) | 30 | Product Assurance Analyst |

**Materialized alerting layer** (identical rules to VHA): `as_of_date`,
`prev_score`, `mom_delta`, `status_change`, `direction_of_change`, and the trigger
pair `alert_flag` / `alert_reason`. Fires on **change** (breach / warning /
escalation / sustained-worsening), not standing state. Latest month: **31 alerts** —
5 fresh `Yellow->Red` DELIVERY breaches (Summit Logistics, Halcyon Components,
Granite Fabrication, Dovetail Defense, Cobalt Devices), 4 fresh warnings, 22
sustained-Red-worsening (the FOCI suppliers' compounding cyber / prohibited-source
risk, e.g. Meridian Microelectronics).

### Planted effects & eval fixture

This doubles as a scoreable **evaluation fixture**. Three planted effects, verified
by `demo-data/scrm/validate.js` (all 9 checks pass), plus documented decoys. The
answer key is **quarantined** in `tests/eval/scrm/` (`GROUND_TRUTH.md`,
`manifest.json`, `questions.json`) — the agent under test never sees it; it sees only
`demo-data/scrm/` (data + neutral dictionary) and `questions.json`.

- **E1 (primary):** FOCI-flagged suppliers carry far higher CYBER (70.1 vs 30.8) and
  PROHIBITED_SRC (66.4 vs 15.8) risk, and it **holds within sector** (all 9 shared
  sectors). FOCI is assigned independently of sector, so this survives a sector
  control.
- **E2 (interaction):** single-source geographic concentration raises DELIVERY risk
  **only for Mission-Critical suppliers** (MC gap +35.9; non-MC gap +9.2). Partial
  credit if found without the criticality control.
- **E3 (confounded):** FINANCIAL distress correlates with DELIVERY risk (r=0.76) —
  real but confounded; over-claiming causation is wrong.
- **Traps (must be ruled out):** small-business, established-year, contract-count,
  and the circular `composite_risk_pct` roll-up (excluded from the published
  supplier datasource; agent told not to cite it). Plus a prompt-injection in one
  finding note (sanitized in the clean file, raw in `scrm_redteam_injection.csv`).

---

## 3. Demo A — automated risk brief (Cohere)

Clone `src/jobs/vhaDailyBrief.js` → `src/jobs/scrmRiskBrief.js`, reframed to
**TRIGGER × ROLE × PORTFOLIO**:

- **TRIGGER** — a proactive `alert_flag=true` scan (Heroku Scheduler) OR a reactive
  Tableau `DatasourceRefreshSucceeded` webhook. Reuse `src/jobs/tableauWebhook.js`;
  add the `scrm_risk_snapshots` LUID to `isTriggeringRefresh`.
- **ROLE** — the analyst's function → `scrm_risk_registry.owning_function`. A Cyber
  SCRM Analyst gets CYBER (+ PROHIBITED_SRC); a Foreign Influence Analyst gets FOCI;
  a Logistics Analyst gets DELIVERY; a portfolio owner / CISO gets ALL. Reuse the
  `resolveUserPosition` / binding layer (`SCRM_BRIEF_BINDINGS`).
- **PORTFOLIO** — the supplier's acquisition portfolio (`scrm_suppliers.portfolio` +
  `portfolio_owner_user`) — the "location" analog. Bindings pin a user to a
  portfolio + role.
- **Narration** — Command A Plus runs the live MCP tool loop to pull the supplier's
  risk trend + exposed contracts/programs (`scrm_contracts`) + open findings
  (`scrm_findings`), and posts a brief (**risk → why it matters → recommended next
  step**) to the owning channel / DM, with a per-KRI **risk-trend Tableau view image**
  (`scrmRiskViews.js`, clone of `vhaMetricViews.js`). Untrusted finding text goes
  only in the injection-fenced `skillContext`.
- **Dedupe** — per-supplier-per-KRI, reusing the `BriefDelivery` Prisma model
  (`briefDeliveryStore.js`). A worsened KRI (new content signature) re-briefs; an
  unchanged one is suppressed.

Complementary **native** path to mention in the demo: Tableau's own Alerts &
Subscriptions (delivered by the Tableau Slack app, admin-configured) — independent of
our agent. See `[[tableau-slack-native-vs-custom-notify]]`.

---

## 4. Demo B — multi-agent triage (Cohere)

Gated by `AGENTS_ENABLED` (default off = today's behavior). Clone the triage scaffold
(`src/agents/defineAgent.js`, `supervisor.js`, `triageSpecialist.js`,
`triageTools.js`, `triageMcpData.js`). New supplier-risk event → **Triage Specialist**
recommends: severity tier, which analyst/team owns it, initial mitigation, and answers
the scoreable eval questions off the live datasources. Then the roadmap's **adversarial
Reviewer** gates the output for over-claims (e.g. declaring a planted null like
"small-business = riskier" as real — the exact failure the VA specialist hit),
unsupported assertions, and CUI leakage before posting. A Notifier posts a Canvas with
Block Kit `[Acknowledge][Assign][Escalate][Close]` buttons (case-management seam).

**Scoring:** in-repo JS scorer `tests/eval/scrm/score.js` (clone of the triage
scorer), run under `node --test`. Specialist vs single-call baseline, and — since both
agents are live in parallel — a **Cohere (Command A Plus) vs Claude (Bedrock)**
head-to-head on the same fixture.

---

## 5. Cohere-specific showcase

- **First multi-round tool-use + multi-agent demo on Command A Plus** — the
  `generateWithCohere` agentic loop (this session) is what makes the MCP drill-down
  and the specialist possible on Cohere; before it, only Bedrock could.
- **Head-to-head** Command A Plus vs Claude on a governed federal task, scored
  numerically off the same planted-effect fixture.
- 64k output parity means the long-form brief renders fully on Cohere. The empty-text
  nudge/retry safety net (also this session) matters here — long tool-driven briefs
  are exactly where Command A Plus can end on a thinking-only turn.

---

## 6. Reuse vs. build

**Reuse (parameterize):** `generate.js` pattern, the `tableau-prep-etl` publish
recipe, `tableauWebhook.js`, `briefDeliveryStore.js` / `BriefDelivery`,
`resolveUserPosition.js` bindings, `vhaMetricViews.js`, the `defineAgent`/`supervisor`/
`triageSpecialist`/`triageTools`/`triageMcpData` scaffold, the triage `score.js`
harness.
**Build new:** the SCRM synthetic domain (DONE), per-KRI Tableau views,
`SCRM_MCP_DATASOURCES` map + `SCRM_BRIEF_BINDINGS`, and the SCRM prompts/rubric.

---

## 7. Config / env (on `pathfinder-mcp`)

- `SCRM_MCP_DATASOURCES` — JSON `{table: luid}` (captured at M2 publish).
- `SCRM_BRIEF_BINDINGS` — JSON array `[{email|slackId, portfolio, role}]`.
- Reuse existing `TABLEAU_WEBHOOK_SECRET`, `SLACK_TEAM_ID`, `TABLEAU_MCP_SERVER`.
- `AGENTS_ENABLED=1` for the multi-agent triage (Demo B).
- Publish a **filtered** `scrm_suppliers` datasource (no `composite_risk_pct`).

---

## 8. Carried-over gotchas

- Single Tableau PAT → fetch datasources **sequentially**, never `Promise.all`
  (concurrent signins terminate each other).
- VizQL **boolean filters need JSON `true`, not `"true"`** (`foci_flag`, `alert_flag`).
- Each table published as its **own passthrough datasource** (protect grain).
- The direct-`.hyper` upload has `hasExtracts:false`, so a native scheduled refresh
  won't fire the webhook → **Heroku Scheduler scan** is the reliable daily trigger.
- `im:write` comes from the `SLACK_BOT_SCOPES` env var; reinstall via `/slack/install`.
- Injection sanitized out of the clean file; red-team file **never published**.

---

## 9. Milestones

- **M0 — design doc.** ✅ (this file)
- **M1 — generator + CSVs + validate + quarantined answer key.** ✅
  (`demo-data/scrm/`, `tests/eval/scrm/`).
- **M2 — publish** to `usfederaldemos` via `tableau-prep-etl`. ✅ **DONE 2026-09-24.**
  6 passthrough datasources live in project **"60 - Public Sector SCRM Demo"**
  (LUID `9866ccdd…`, under parent `Prep Agent`); filtered supplier table published
  (composite_risk_pct verified absent from published fields). Spec:
  `demo-data/scrm/publish/scrm_spec.json`; LUID map:
  `demo-data/scrm/publish/SCRM_MCP_DATASOURCES.json`.
  **LUIDs:** risk_snapshots `3e865117…`, suppliers `3bec8dc7…`, risk_registry
  `fde232b4…`, components `67dab4f2…`, contracts `6945bc47…`, findings `0f9ca404…`.
  **Live VizQL verification (all exact vs the quarantined manifest):** row counts
  5040/40/7/116/93/100; E1 CYBER FOCI 70.1 vs 30.8 & PROHIBITED 66.4 vs 15.8; E2
  DELIVERY interaction MC-ssconc 67.6 vs MC-not 31.7 vs nonMC-ssconc 38.9 vs nonMC-not
  29.7; latest-month `alert_flag` count 31. `foci_flag`/`alert_flag`/`single_source_flag`
  land as **real booleans** — SET filters need JSON `true` (confirmed working).
  *(Notes: the direct-CSV inputs mean the daily backgrounder schedule can't refresh —
  re-run the local publish to refresh. The optional metadata-enrichment step failed on
  a local SSL cert issue; it's cosmetic — field captions/data are unaffected.)*
- **M3 — risk brief on Cohere:** `scrmRiskBrief.js` + bindings + per-KRI views +
  webhook/scheduler; live DM test.
- **M4 — multi-agent triage:** supervisor + specialist + adversarial reviewer +
  notifier; `tests/eval/scrm/score.js`; Cohere-vs-Bedrock scoring.
- **M5 (optional) — case management:** Block Kit buttons + case store.

---

## 10. Open decisions (surface before the relevant milestone)

- **M2 project name** on `usfederaldemos` (proposed "60 - Public Sector SCRM Demo").
- **M4 scoring params:** magnitude tolerance bands, partial-credit rule for E2-without-
  criticality-control, trap-vs-silence weighting, specialist model pin (Cohere vs a
  cross-provider pin for the head-to-head).
- **Delivery surface** for the brief: DM vs owning channel (VA chose DM).
