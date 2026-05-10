# Internet Search Toggle — End-to-End Test Runbook

Tests the full user-facing behaviour of the per-user Internet Search toggle: opt-in/out,
context priority, graceful degradation when off, and the ability to combine web search
grounding with canvas and Tableau tools in the same turn.

---

## Pre-requisites

1. **App deployed** to Heroku (`feat-internet-knowledge` branch or later).
2. **`SLACK_CONTEXT_DEBUG=1`** set as a Heroku config var — required for all log assertions.
3. **Heroku log stream open** in a terminal before each test run:

```bash
# Stream all logs
heroku logs --tail -a naseer-mcp-agent-dev

# Focused: internet search decisions only
heroku logs --tail -a naseer-mcp-agent-dev | grep "useInternetSearch"

# Focused: Vertex AI errors only
heroku logs --tail -a naseer-mcp-agent-dev | grep "Vertex/Gemini error"
```

4. The test user has **re-installed the app with user scopes** (required for canvas tools
   and per-user preference storage).

---

## Test Cases

---

### TC-1 — Toggle OFF (default): real-time question gets a helpful refusal

**Setup:** Open App Home → Settings. Confirm Internet Search shows ⚪ Disabled ("Enable"
button visible). If it shows Enabled, click Disable first.

**Prompt (Assistant thread DM):**
```
What's the weather in Nairobi right now?
```

**Expected response — MUST contain:**
- A phrase like *"real-time web access"* or *"live web"*
- A reference to enabling it: *"App Home → Settings"* or *"Internet Search"*

**Expected response — MUST NOT contain:**
- Actual weather data (temperature, conditions)
- "Something went wrong on my side"
- "I am sorry, I cannot fulfill this request"

**Expected Heroku log:**
```
[slack-mcp-agent] assistant useInternetSearch=false userId=U…
```

---

### TC-2 — Toggle ON: real-time weather question is answered

**Setup:** Open App Home → Settings → click **Enable**. Confirm ✅ Enabled and "Disable"
button appear.

**Prompt (Assistant thread DM):**
```
What's the weather in Nairobi right now?
```

**Expected response — MUST contain:**
- Actual weather conditions for Nairobi (temperature, sky conditions, or similar)

**Expected response — MUST NOT contain:**
- "real-time web access" refusal message
- "Something went wrong on my side"

**Expected Heroku log:**
```
[slack-mcp-agent] assistant useInternetSearch=true userId=U…
[slack-mcp-agent] tools=[{"googleSearch":{}},...] useCanvasTools=true useTableauTools=false
```

---

### TC-3 — Toggle ON: factual knowledge question

**Setup:** Internet Search enabled (from TC-2).

**Prompt:**
```
Who won the 2024 UEFA Champions League?
```

**Expected response:** Real Madrid (correct factual answer). Concise and direct.

**Expected log:**
```
[slack-mcp-agent] assistant useInternetSearch=true userId=U…
```

---

### TC-4 — Priority: Slack context wins when the answer is already there

**Setup:** Internet Search enabled. Identify a topic that was discussed in a Slack channel
recently (e.g. a team decision, a project name, a meeting outcome).

**Prompt (opened from that channel, or with #channel-name reference):**
```
What did we decide about [the topic from Slack]?
```

**Expected response:** Summarises or quotes from the Slack thread. Does NOT cite external
web sources for something clearly in the workspace.

**Expected log:**
```
[slack-mcp-agent] assistant useInternetSearch=true userId=U…
[slackContext] …
```
*(The `[slackContext]` line confirms Slack context was built and used.)*

---

### TC-5 — Canvas + Internet Search together (both active simultaneously)

**Setup:** Internet Search enabled. User has a user token (canvas tools active).

**Prompt:**
```
What's the weather in Nairobi right now and create a canvas summarising it
```

**Expected response:**
- Contains actual current weather data for Nairobi (from Google Search grounding)
- Creates a canvas with that information
- NO "Something went wrong on my side"
- NO message saying canvas tools are paused or unavailable

**Expected log:**
```
[slack-mcp-agent] assistant useInternetSearch=true userId=U…
[slack-mcp-agent] tools=[{"googleSearch":{}},{"functionDeclarations":[...]}] useCanvasTools=true useTableauTools=false
```

> Validates that `googleSearch` and `functionDeclarations` coexist as separate entries in the
> tools array — the Vertex AI `oneof` constraint is per Tool object, not across the array.
> Both grounding and canvas tools are active in the same turn.

---

### TC-6 — Toggle persistence across new threads

**Setup:** Internet Search enabled from a previous session. Close the assistant thread
completely. Open a brand new assistant thread.

**Prompt:**
```
What's the weather in Nairobi right now?
```

**Expected response:** Actual weather data (toggle persisted in DB across sessions).

**Expected log:**
```
[slack-mcp-agent] assistant useInternetSearch=true userId=U…
```

---

### TC-7 — Toggle OFF after being ON: refusal message returns

**Setup:** Open App Home → Settings → click **Disable**. Confirm ⚪ Disabled and "Enable"
button appear.

**Prompt:**
```
What's the weather in Nairobi right now?
```

**Expected response:** Back to the helpful refusal with the Settings link. MUST NOT contain
weather data.

**Expected log:**
```
[slack-mcp-agent] assistant useInternetSearch=false userId=U…
```

---

### TC-8 — @mention path reads the preference correctly

**Setup:** Internet Search enabled.

**Prompt (in a public channel, @-mentioning the bot):**
```
@PrismBot What's the current price of gold per ounce?
```

**Expected response:** Actual gold price or live market information.

**Expected log:**
```
[slack-mcp-agent] app_mention useInternetSearch=true userId=U…
```

> This validates that the `app_mention` handler (separate code path from the Assistant
> thread handler) also reads the preference correctly.

---

### TC-9 — Missing userId surfaces in logs (diagnostic)

**Setup:** Internet Search enabled. Trigger the bot from a context where `userId` may not
be present (e.g. a Workflow Builder step that calls the bot, or an automated event without
a user context).

**Expected response:** Bot responds (no crash), but may not use internet search.

**Expected log (if userId was missing):**
```
[userPreferences] getInternetSearchEnabled: no userId — returning false
```

> If this line appears when the toggle is ON, it means the Slack event body is not
> providing a userId in any of the fallback fields — the install query needs an
> additional extraction path for that event type.

---

## Settings UI Checks

Visual validation — no Heroku logs needed.

| Step | Action | Expected UI |
|------|--------|-------------|
| 1 | Open App Home → Settings (toggle OFF) | ⚪ *Internet Search — Disabled*, blue "Enable" button |
| 2 | Click **Enable** | Page refreshes: ✅ *Internet Search — Enabled*, red "Disable" button |
| 3 | Click **Disable** | Page refreshes: ⚪ *Internet Search — Disabled*, blue "Enable" button |
| 4 | Navigate away (Home) and back (Settings) | State persists — shows last-saved toggle value |

---

## Pass Criteria

| # | Scenario | Pass condition |
|---|----------|---------------|
| TC-1 | Toggle OFF — refusal | Helpful message with Settings link; no weather data; no "went wrong" |
| TC-2 | Toggle ON — weather | Actual Nairobi weather in response |
| TC-3 | Toggle ON — knowledge | Correct Champions League answer |
| TC-4 | Slack context priority | Slack-sourced answer, no irrelevant web citations |
| TC-5 | Canvas + search simultaneously | Real weather data AND canvas created; no error |
| TC-6 | Persistence | Toggle ON persists across new thread |
| TC-7 | Toggle OFF again | Refusal message returns; no weather data |
| TC-8 | @mention path | Correct live data in channel reply |
| TC-9 | Missing userId | No crash; diagnostic log visible if userId absent |
| UI-1–4 | Settings UI | Toggle state renders correctly and persists |

Zero occurrences of "Something went wrong on my side" during any test with toggle ON or OFF.
