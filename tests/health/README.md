# slack-mcp-agent health-check framework

A single harness for two jobs:

1. **Deploy-time smoke test** — run once, right after a deploy, to confirm the
   app is actually wired up: required config present, secrets/SSRF guards intact,
   and the LLM + Tableau MCP endpoints reachable.
2. **Ongoing monitoring** — run on a schedule to catch the things that rot
   *after* a green deploy:
   - **model drift** — a new model version starts refusing benign asks, ignoring
     grounding, leaking the system prompt, or obeying injected instructions;
   - **context rot** — as a customer's Tableau site grows, datasources fall
     outside the catalog the model sees, or a target stops ranking #1;
   - **config / routing regressions** — an env change or an intent-router edit
     silently changes behavior.

Everything is **read-only**. It performs Tableau list/metadata reads and LLM
calls; it never writes to Slack, the database, or Tableau, and it never prints
secrets.

---

## Two layers

| Layer | What | When it runs |
|-------|------|--------------|
| **Offline unit checks** (`tests/healthChecks.test.js`) | The framework's own judgement logic — config rules, drift scoring, routing goldens, context-rot analysis — run as pure functions with no network. | Every `npm test` / CI. |
| **Live runner** (`tests/health/runner.js`) | Wraps the same logic with real network calls (LLM ping, Tableau MCP ping, live golden-prompt eval, live catalog size). | Deploy release phase + scheduled cron. |

The judgement logic lives in `lib/checks.js` and is exercised by `npm test`, so
the rules that decide "is this deploy healthy?" are themselves covered and can't
silently drift.

---

## Running it

```bash
# Deploy-time readiness (config + SSRF + live LLM & Tableau pings)
npm run health:smoke

# Ongoing behavioral checks
npm run health:drift          # golden routing (offline) + golden prompts (live LLM)
npm run health:contextrot     # datasource-catalog growth (simulated)
npm run health:contextrot -- --live-tableau-scale   # also measure the REAL catalog

# Everything
npm run health

# Machine-readable for dashboards / alerting
node tests/health/runner.js all --json
# Per-item detail on failures
node tests/health/runner.js drift --verbose
```

**Exit codes:** `0` = no failures (warnings allowed), `1` = ≥1 check failed,
`2` = runner error. Suitable for a release phase or a cron that alerts on
non-zero.

The runner loads `.env` (via dotenv) so a local run picks up your dev config.
On Heroku the config vars are already in the environment.

### Environment knobs
- `HEALTH_LLM_TIMEOUT_MS` (default 30000) — per LLM call.
- `HEALTH_MCP_TIMEOUT_MS` (default 20000) — per Tableau MCP call.

---

## Recommended cadence

| Check | When | Why |
|-------|------|-----|
| `health:smoke` | **Every deploy**, as a Heroku release-phase step | Fails the release if the app can't reach its LLM/Tableau or is misconfigured, before it takes traffic. |
| `health:drift` | **Daily**, and **immediately after any model-version or prompt change** | Model providers roll model versions under you; the golden prompts catch a behavior change the same day, not via a user complaint. |
| `health:contextrot` | **Weekly**, and after onboarding a data-heavy tenant | Tableau sites grow; this flags when datasources start falling outside the catalog the model sees. |
| `--live-tableau-scale` | **Weekly** (needs a configured Tableau endpoint) | Measures the *real* catalog size vs. the server list limit — the deepest rot boundary. |

### Wiring it into Heroku

Release-phase smoke test (fails the deploy on a `fail`), in `Procfile`:

```
release: npm run deploy:migrate && npm run health:smoke
web: npm start
```

Scheduled monitoring — add the **Heroku Scheduler** add-on and a daily job:

```
node tests/health/runner.js drift --json
```

(Or run drift+contextrot from an external cron / CI schedule and alert on a
non-zero exit or `counts.fail > 0` in the JSON.)

---

## What each check means, and how to react

### Smoke
- **`SLACK_*`, `DATABASE_URL`, scopes = FAIL** → the app won't boot / auth.
  Set the config var.
- **`TOKEN_ENC_KEY` = WARN** → tokens stored in plaintext. Set it:
  `heroku config:set TOKEN_ENC_KEY="$(openssl rand -base64 32)"`.
  **`TOKEN_ENC_KEY` = FAIL** → it's set but malformed; fix or unset it (a broken
  key must never be deployed — see the "Fix 1" regression in `tokenCrypto.test.js`).
- **`TABLEAU_MCP_SERVER` = FAIL** → not https or not a public host (SSRF guard).
  Use a public https URL, or set `TABLEAU_MCP_ALLOW_PRIVATE=1` for a private
  self-host target (that downgrades it to a WARN).
- **`LLM provider` = FAIL** → `AI_PROVIDER` asks for gateway/bedrock but that
  backend is incompletely configured, so the app is silently falling back to
  vertex. Complete the config or change `AI_PROVIDER`.
- **`LLM reachability` = FAIL** → the live probe couldn't get a completion. This
  calls `generateReply` directly (not `getAiResponse`, which swallows errors and
  returns a friendly fallback), so a FAIL is a real outage.
- **`Tableau MCP reachability` = WARN (0 rows)** → session works but
  `list-datasources` parsed to nothing: empty site, permissions, or a
  **response-shape change** on the MCP server (this is exactly the v4
  `{data:[]}` regression the parser test guards).

### Drift
- **`Intent routing (golden)` = FAIL** → an intent-router regex edit changed how
  a golden message routes. Either a real regression or a deliberate change —
  update the golden case in the same commit so it's reviewable.
- **`Model behavior (golden prompts)` = FAIL** → the live model drifted on one
  of: spurious refusal, fabricating figures without data, **complying with a
  prompt injection**, or **leaking the system prompt**. Investigate the model
  version first. A swallowed infra error is scored as a FAIL too (never a false
  pass).

### Context rot
- **`Datasource ranking under growth` = FAIL** → the ranker stopped resolving a
  known target to #1 as the simulated catalog grew. A scoring regression.
- **`Catalog display coverage` = WARN** → at some scale, datasources exceed the
  ~500-row cap the model sees in the compact catalog. Fine until a *specific*
  needed datasource is the one hidden.
- **`Live catalog size` = WARN** → the real site has more datasources than
  `TABLEAU_MCP_DATASOURCE_LIST_LIMIT`, so the server truncated the list before
  the app ever saw it. Raise the limit or rely on name-filtered lookups.

---

## Extending it

- **Add a golden prompt** (behavioral contract) → `fixtures/golden-cases.js`,
  `DRIFT_CASES`. Use property checks (`includesAny` / `excludesAll` / `minLen`),
  never exact-string equality — model wording varies legitimately.
- **Add a routing expectation** → `fixtures/golden-cases.js`, `ROUTING_CASES`.
  Runs offline against the real `classifyIntent`.
- **Add a config rule** → `lib/checks.js`, `validateDeployConfig`, and cover it
  in `tests/healthChecks.test.js`.
- **Change the context-rot scales / target** → `runner.js` `runContextRot` and
  `fixtures/syntheticCatalog.js`.

## Files
```
tests/health/
  runner.js                    CLI: smoke | drift | contextrot | all
  lib/checks.js                pure judgement logic (unit-tested)
  fixtures/golden-cases.js     routing + drift golden cases
  fixtures/syntheticCatalog.js deterministic catalog generator for growth sims
tests/healthChecks.test.js     runs the judgement logic in CI (npm test)
```
