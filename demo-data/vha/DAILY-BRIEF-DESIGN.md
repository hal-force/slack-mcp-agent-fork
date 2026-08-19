# Automated localized brief — design

**Goal (Arthur Keeffe's ask, stated precisely):** *"have a subscription or alert
arrive, and drive an automated response from the agent parameterized to the
trigger and the user's position/location."*

So every brief is a function of **three** independently-resolved inputs:

```
   brief  =  f( TRIGGER ,  POSITION ,  LOCATION )
             │            │            │
             │            │            └─ WHICH facility  (Slack tz + identity)
             │            └─ WHICH metrics they own (Slack role/title → owning_function)
             └─ WHAT fired: a daily SCAN, or an inbound ALERT
```

- **TRIGGER** — two sources, one downstream path: a proactive daily **scan** of
  `alert_flag=true` metrics (Scheduler, hourly, local-hour gated), *or* a
  reactive inbound **alert** (Pulse/subscription) naming the metric that fired.
- **POSITION** — the user's role → the registry `owning_function`(s) they own.
  This is what turns a facility metric **dump** into a role-relevant nudge: a
  Quality Manager gets SMR30+OMELOS, an Access Manager gets RVU capacity, a
  Director gets the whole facility.
- **LOCATION** — the facility, inferred from Slack `tz` + identity; the brief
  arrives at a sensible **local** hour.

This doc is the blueprint; the pieces marked ✅ are built and tested against the
live sources on `usfederaldemos → VA | Veterans Affairs`.

---

## The daily loop (end to end)

```
  Heroku Scheduler (hourly, UTC)
        │
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. WHO fires now?  Per-timezone gate.                         │
  │    For each tz where local time == BRIEF_HOUR (e.g. 07:00),   │
  │    select the users in that tz. (A daily job that runs hourly │
  │    and self-gates on local hour = every user briefed at their │
  │    OWN 7am without 24 separate schedules.)                    │
  └─────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 2a. WHERE are they?  resolveUserFacility.js  ✅  (LOCATION)   │
  │    users.info → { tz, tz_label, locale, id, profile.fields }  │
  │    TIER 1 explicit binding (profile "VHA Facility" field, or  │
  │           director_user==Slack id in the demo)  → exact       │
  │    TIER 2 tz → candidate states → facilities                  │
  │           • 1 match  → that facility                          │
  │           • N match  → region/VISN-level brief OR ask once     │
  │    TIER 3 none → skip (or a national digest, opt-in)          │
  │                                                               │
  │ 2b. WHAT do they own?  resolveUserPosition.js  ✅  (POSITION) │
  │    users.info → { id, profile.title, profile.fields }         │
  │    TIER 1 explicit "VHA Function" field → owning_function     │
  │    TIER 1b director id → ALL functions (facility-wide brief)  │
  │    TIER 2 job title → owning_function(s) (token match)        │
  │    TIER 3 none → skip that user (don't dump the facility)     │
  └─────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 3. WHAT changed?  TRIGGER (deterministic, no LLM).            │
  │    SCAN:  query VHA Metric Snapshots, filter                  │
  │      period_month = <latest>, alert_flag = true               │
  │      (JSON boolean true — NOT "true"; see gotcha below)       │
  │    ALERT: the inbound payload names the breached metric(s).   │
  │    → the facility's metrics + alert_reason, ranked …          │
  │    … THEN filtered to the user's POSITION (step 2b): keep     │
  │      only metrics whose owning_function the user owns.        │
  │    This is the SAME alert_flag the Prep layer materializes, so │
  │    Pulse and the brief agree on "what's worth a nudge".       │
  └─────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 4. SO-WHAT?  getAiResponse() with live Tableau MCP tools.     │
  │    Per flagged metric, the agent pulls the 6-mo trend + the   │
  │    linked action plan (barriers/owner/progress) and writes a  │
  │    short narrative. Action-plan free text is injection-fenced.│
  └─────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 5. DELIVER.  Post to the metric's owning_channel (registry),  │
  │    or DM the user. Header carries alert_reason + as_of_date.  │
  └─────────────────────────────────────────────────────────────┘
```

Narrative + fencing (steps 4–5) live in `src/jobs/vhaLocalizedDigest.js` and are
reused by the brief job. Step 2a is `resolveUserFacility.js`, step 2b is
`resolveUserPosition.js`, and `src/jobs/vhaDailyBrief.js` orchestrates all of it
behind two entry points:

- `run()` — the scheduled **scan** over the roster (proactive daily).
- `runFromAlert({userId, metricKeys})` — one inbound **alert** → one targeted
  brief (reactive). Position still gates it: an SMR30 alert routed to a Care
  Transitions Lead is *suppressed*, not dumped.

Both share `selectBriefRows()` (pure: resolve position+location, pick rows,
filter by owning_function) → `narrateSections()` → `deliver()`.

---

## Slack metadata we key off (all from `users.info`)

| Field | Use | Note |
|---|---|---|
| `tz` (`America/Phoenix`) | location inference + **local send-hour gate** | already read by `userLocale.js` |
| `tz_label`, `locale` | brief phrasing, units, date format | `en-US` → imperial/US dates |
| `id` (`U…`) | explicit facility + director binding | demo: `director_user` == Slack id |
| `profile.title` | **position** inference (role → owning_function) | e.g. "Quality Manager" → SMR30/OMELOS |
| `profile.fields` | prod facility ("VHA Facility") + function ("VHA Function") binding | portable label match in resolvers |

**Timezone is not enough on its own** — verified live: `America/Los_Angeles`
maps to 4 CA/OR facilities, `America/New_York` to 3 NY facilities,
`America/Phoenix` to 2 AZ facilities. So tz **narrows**, the explicit binding
**pins**. The resolver returns a candidate set when tz is ambiguous, so the
caller can brief at VISN/region grain or ask the user to confirm once (then
cache the answer as an explicit binding — ambiguity is a one-time cost).

---

## The MCP call, concretely

Each brief is a sequence of `query-datasource` calls the agent already knows how
to make (proven by `mcp_demo_queries.py`, 9/9). The daily trigger is one call:

```jsonc
// query-datasource on VHA Metric Snapshots (LUID 7b92fd7b-…)
{
  "fields": [
    {"fieldCaption": "metric_caption"},
    {"fieldCaption": "rag_status"},
    {"fieldCaption": "status_change"},
    {"fieldCaption": "alert_reason"},
    {"fieldCaption": "value", "function": "SUM"},
    {"fieldCaption": "pct_to_target", "function": "SUM"}
  ],
  "filters": [
    {"field": {"fieldCaption": "facility_name"}, "filterType": "SET",
     "values": ["Phoenix, AZ HCS"]},
    {"field": {"fieldCaption": "period_month"}, "filterType": "SET",
     "values": ["2026-07"]},
    {"field": {"fieldCaption": "alert_flag"}, "filterType": "SET",
     "values": [true]}          // JSON boolean — see gotcha
  ]
}
```

### ⚠️ VizQL boolean-filter gotcha (found + fixed during testing)
A SET filter on the **boolean** `alert_flag` needs a JSON `true`, **not** the
string `"true"` — the string throws `400803 "Unable to convert value true for
Filter on Field alert_flag"`. Confirmed live. Either emit the JSON boolean, or
omit the filter and let the code read `alert_flag`/`alert_reason` and filter
client-side (what the CSV-path digest does today).

---

## Trigger option A — Tableau datasource-refresh webhook (push) ✅

Instead of polling, let Tableau Cloud **push** us the moment new snapshot data
lands. When the `VHA Metric Snapshots` extract refreshes, `alert_flag` has just
been recomputed — the natural instant to (re)brief.

**Receiver:** `src/jobs/tableauWebhook.js` mounts `POST
/webhooks/tableau/refresh/:secret` on the Bolt Express receiver (separate path
from Slack's events endpoint, so Slack signature verification is untouched). It
fast-acks 200 and runs `vhaDailyBrief.runFromRefresh(payload)` in the
background (LLM fan-out is slow; Tableau wants a prompt 2xx or it retries →
dupes, which the dedupe guard also defends against).

**Verified Tableau behaviour** (help.tableau.com/current/developer/webhooks):
- Events: `DatasourceRefreshStarted` / `…Succeeded` / `…Failed`. We act on
  **Succeeded only** (Started = nothing new; Failed = data did *not* change).
- POST, JSON body: `{resource:"EXTRACTS", event_type, resource_name,
  resource_luid, site_luid, created_at}`.
- Destination **must be https with a valid cert** — Heroku qualifies.
- The **"Test" button sends an empty payload** — we 200 it and no-op.
- Tableau webhooks are **not signed** (no HMAC header). Authenticity rests on a
  **secret in the path** (`TABLEAU_WEBHOOK_SECRET`), compared timing-safely.
  Without the secret set the route **refuses to arm** (no unauthenticated
  endpoint that fans out DMs).

**Set it up:**
```bash
# 1. pick a strong secret and set it on the app
heroku config:set TABLEAU_WEBHOOK_SECRET=<random-hex> -a damp-wave-30118
# 2. register the webhook on the Tableau site (usfederaldemos) via REST API:
#    POST /api/3.x/sites/<site-luid>/webhooks
#    { "webhook": { "webhook-source": { "webhook-source-event-datasource-refresh-succeeded": {} },
#      "name": "VHA brief on refresh",
#      "webhook-destination": { "webhook-destination-http": { "method": "POST",
#        "url": "https://damp-wave-30118-c50c0988f195.herokuapp.com/webhooks/tableau/refresh/<secret>" } } } }
# 3. use the Tableau UI "Test" button → expect 200; then refresh Snapshots → briefs fire.
```
Local smoke test (no Tableau needed):
```bash
VHA_BRIEF_DRY_RUN=1 node src/jobs/vhaDailyBrief.js \
  --refresh '{"event_type":"DatasourceRefreshSucceeded","resource_name":"VHA Metric Snapshots"}'
```

Dedupe: `run({dedupe:true})` consults the **durable** `BriefDelivery` ledger
(Postgres via `briefDeliveryStore.js`), PER METRIC: a metric that is new or has
WORSENED (its `contentSig` over rag_status/value/status_change/alert_reason
changed) is sent; one already delivered unchanged this reporting month is
suppressed. Rows are marked sent only AFTER a successful DM, so a post failure
retries next run. Survives dyno restarts/deploys. Fail-open — if the DB is
unavailable, briefs still deliver (we just lose cross-run dedupe). Verified:
first refresh DMs 5 users, an identical second refresh suppresses all 5
(`dup=5`).

---

## Trigger option B — Heroku Scheduler (poll, fallback)

If webhooks aren't available, Heroku Scheduler only does UTC at
10-min/hourly/daily cadence, so we get local send-times by running **hourly**
and self-gating:

```bash
# Procfile-adjacent one-liner the Scheduler runs every hour:
BRIEF_HOUR_LOCAL=7 SLACK_TEAM_ID=… node src/jobs/vhaDailyBrief.js
```

`vhaDailyBrief.js` `run()` does exactly this:
1. list the target users (demo: `demo_roster.json`; prod: members of the VA
   channels or a roster; override with `VHA_BRIEF_USERS`),
2. `users.info` each → keep those whose **local hour == BRIEF_HOUR_LOCAL**
   (`localHourInTz`, DST-correct via `Intl`),
3. `resolveUserFacility` (LOCATION) + `resolveUserPosition` (POSITION),
4. select this facility's flagged rows, **filter to the user's owning_function**,
   narrate each, and DM one consolidated brief.

The reactive counterpart is `runFromAlert({userId, metricKeys})` — same
selection path, `--alert '{"userId":"U_PHX_QM","metricKeys":["SMR30"]}'` on the
CLI. Verified in dry-run: same Phoenix facility yields four *different* briefs by
role, and an off-lane alert is suppressed.

Idempotency: durable per-metric dedupe (see the `BriefDelivery` note above) so
an hourly re-run or repeat webhook never double-posts the same month's brief.

---

## Testing with a real user (e.g. jgillmore@salesforce.com)

A real Slack account isn't in the synthetic roster, so we PIN it with an
explicit binding rather than relying on tz/title guesses. `VHA_BRIEF_BINDINGS`
is a JSON array; a `director` role gives a facility-wide brief (all flagged
metrics), a function name (e.g. `"Quality Manager"`) scopes to that role's
metrics. Email is resolved live via `users.lookupByEmail` (bot has
`users:read.email`); in dry-run supply `slackId` instead.

Prereqs for a LIVE DM: (1) `im:write` bot scope — **reinstall** the app after
the manifest change; (2) `SLACK_TEAM_ID` set to the workspace; (3) the app
installed there (bot token in the install store).

```bash
# 1. DRY-RUN preview (no Slack, no scope) — pin to Phoenix + Director:
VHA_BRIEF_DRY_RUN=1 VHA_BRIEF_IGNORE_HOUR=1 \
VHA_BRIEF_BINDINGS='[{"slackId":"U_DIR_PHX","facilityName":"Phoenix, AZ HCS","role":"director"}]' \
node src/jobs/vhaDailyBrief.js

# 2. LIVE DM to the real user (after im:write reinstall). Email → id happens
#    inside the job; the binding pins facility+role:
SLACK_TEAM_ID=<T…> VHA_BRIEF_IGNORE_HOUR=1 \
VHA_BRIEF_BINDINGS='[{"email":"jgillmore@salesforce.com","facilityName":"Phoenix, AZ HCS","role":"director"}]' \
node src/jobs/vhaDailyBrief.js
# On Heroku:  heroku run -a damp-wave-30118 'SLACK_TEAM_ID=… VHA_BRIEF_IGNORE_HOUR=1 VHA_BRIEF_BINDINGS=… node src/jobs/vhaDailyBrief.js'

# 3. LIVE via the webhook path end-to-end (simulate a Tableau refresh):
curl -sS -X POST \
  "https://damp-wave-30118-c50c0988f195.herokuapp.com/webhooks/tableau/refresh/$TABLEAU_WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{"event_type":"DatasourceRefreshSucceeded","resource_name":"VHA Metric Snapshots"}'
# (the webhook path uses dedupe — a second identical call suppresses; a worsened metric re-sends)
```

`VHA_BRIEF_IGNORE_HOUR=1` bypasses the 7am-local gate so a test fires
immediately regardless of the clock.

---

## Build status

| Piece | State |
|---|---|
| 4 published sources, queryable | ✅ live on `VA \| Veterans Affairs` |
| Live query battery (9 demo questions) | ✅ `mcp_demo_queries.py` 9/9 |
| `alert_flag` temporal trigger | ✅ materialized + query-verified |
| Facility resolver (tz + identity) — LOCATION | ✅ `resolveUserFacility.js` (tiered, tested) |
| Position resolver (role → owning_function) — POSITION | ✅ `resolveUserPosition.js` (tiered, tested) |
| So-what narrative + injection fencing | ✅ `vhaLocalizedDigest.js` |
| Brief job: (trigger × position × location), scan + alert paths | ✅ `vhaDailyBrief.js` (dry-run verified) |
| Demo roster fixture (non-director roles) | ✅ `demo_roster.json` |
| Datasource-refresh webhook (push trigger) | ✅ `tableauWebhook.js` + `runFromRefresh` (7 tests pass) |
| Durable per-metric dedupe (survives dyno restart) | ✅ `BriefDelivery` model + `briefDeliveryStore.js` (5 tests) |
| Register webhook on Tableau site + set `TABLEAU_WEBHOOK_SECRET` | ▷ ops step (commands above) |
| Run `prisma migrate deploy` (adds BriefDelivery table) | ▷ auto on next Heroku release (release phase) |
| Heroku Scheduler (poll fallback) | ▷ optional |
| `im:write` manifest reinstall (proactive DM) | ▷ pending reinstall |
| Per-column metadata enrichment | ▷ needs `LLM_GATEWAY_URL/KEY/MODEL` |
