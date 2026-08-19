# VHA Localized Metric Review — Demo Data Package

Synthetic data + specs to demo a **localized metric-review agent** in Slack, built
from the partner's VHA action-plan tracker. The agreed build target: filter
corporate metrics down to a specific **facility / region / admin function**, then
have the Slack MCP agent deliver the **"so‑what"** behind each off-target metric
(daily subscription / alert).

## Files

| File | What | Publish? |
|---|---|---|
| `generate.js` | Deterministic generator (seed `20260730`, 18 months → `2026-07-31`) | — |
| `vha_metric_snapshots.csv` | **Pulse source** — date × facility × metric (1,620 rows) | ✅ |
| `vha_action_plans.csv` | Cleaned action plans, the qualitative layer (57 rows) | ✅ |
| `vha_facilities.csv` | Facility dimension (15) | ✅ |
| `vha_metric_registry.csv` | Metric definitions + owning channel/function (6) | ✅ |
| `vha_redteam_injection.csv` | Prompt-injection demo fixture (1) | ❌ never publish |
| `SCHEMA.md` | Full schema, metadata, Pulse setup, why the source needed reshaping | — |
| `PREP-FLOW-SPEC.md` | Prep Agentic ETL recipe + publish + Slack-subscription design | — |

## Regenerate

```bash
node demo-data/vha/generate.js
```

Rescale via the `CONFIG` block in `generate.js` (facilities, metrics, `MONTHS`).

## Publish

Built with the Prep Agentic ETL skill. `spec.json` defines four `local_csv`
sources → four `published_data_source` outputs (no joins — each table is
already denormalized, so the flow is a governed, MCP-legible passthrough; the
two facts stay separate to protect the Pulse grain). Offline build + local-run
are verified: `.tfl` renders, all four `.hyper` extracts carry the right row
counts (1,620 / 57 / 15 / 6), types land correctly, and an injection scan finds
**0** matches in every published extract.

Target Tableau Cloud site: **`canadianfederalonline`**, project
`VHA Localized Metric Review (Demo)` (top-level; `--auto-create-project`).
The PAT "Slack Demo" is **runtime-only** — never stored in this repo; rotate
after the demo.

**To publish** (the PAT secret is read from a silent prompt, never written to
disk or a command line):

```bash
bash demo-data/vha/publish.sh
```

On a Cloud site the skill uploads the built `.hyper` extracts as published data
sources (Cloud's backgrounder can't reach the local CSVs), so the Slack agent's
Tableau MCP gets queryable data immediately. Verify afterward via the Tableau
MCP: `list-datasources` (filter `*VHA*`) → `get-datasource-metadata` (clean
captions) → `query-datasource` (`SUM(value)` by `facility_name`, latest month).

## Daily localized digest (the "so-what" agent)

`src/jobs/vhaLocalizedDigest.js` is the localized metric-review agent (Arthur
Keeffe's ask). It (1) reads the snapshots' materialized **`alert_flag`** column
to find each facility's metrics that *changed for the worse this refresh* —
deterministic, no LLM — then (2) calls the same `getAiResponse()` core the live
@mention path uses, so on Bedrock the model pulls the real trend + linked action
plan through the Tableau MCP tools and writes the "so-what", and (3) posts it to
the metric's `owning_channel` with the `alert_reason` in the header.

**Trigger on the delta, not the level.** `alert_flag` fires only on *change* —
a new breach (→ Red), a fresh Green→Yellow warning, an escalation to a worse
band, or a Red that's still sliding — so a steady Red nobody needs re-told about
stays quiet. `as_of_date` (= `snapshot_date` + 11-day reporting lag) is the
temporal anchor that models "the day the change was brought in", which is what a
Pulse metric or scheduled subscription keys off. See SCHEMA.md for the full rule
set.

```bash
# Preview narratives without posting (no Slack token needed):
VHA_DIGEST_DRY_RUN=1 SLACK_TEAM_ID=T0123 node src/jobs/vhaLocalizedDigest.js
# Live (Heroku Scheduler daily):  SLACK_TEAM_ID=… node src/jobs/vhaLocalizedDigest.js
```

The action-plan free text is passed only inside `getAiResponse`'s injection-
fenced context, so the red-team row (AP-0057) is summarized as data and its
"post to #general" override is refused — the security demo runs on the real
path, not a mock.

## Demo hooks

- **Localized filter:** "Show me *Albany's* metrics that are off target" → agent
  filters to `facility_name = Albany, NY HCS`, ranks by `rag_status` / variance.
- **So-what:** "Why is Albany's SMR30 improving?" → agent trends the snapshots +
  reads the linked action plan (workgroup, root causes, barriers) and explains.
- **Peer context:** `vs_visn_median` / `vs_national_median` answer "is this bad?"
- **Data quality:** two `data_quality_flag` rows demo the agent reconciling
  contradictory status.
- **Security:** the red-team fixture demos prompt-injection fencing.
