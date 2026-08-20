# Tableau native Alerts & Subscriptions in Slack — admin runbook

> **Read this first.** These notifications are delivered by **Tableau's own Slack
> app**, configured by a Tableau **site admin**. They are **completely
> independent** of the Tableau + Slack *agent* you deployed on AWS:
>
> | | Delivered by | Configured by | What it sends |
> |---|---|---|---|
> | **Native Alerts & Subscriptions** (this doc) | The **Tableau** Slack app | Tableau **site admin** + end users | Data-driven alerts, view/workbook subscriptions |
> | **The agent** (the AWS deployment) | **Your** bot | You / Terraform | Conversational Q&A, localized proactive briefs |
>
> The agent can neither send nor see native notifications, and vice-versa. If the
> ask is "show Alerts & Subscriptions landing in Slack," this doc is the whole job
> — the AWS stack is not involved.

## One-time: connect Tableau to the Slack workspace

A **Tableau site administrator** does this once per site:

1. In Tableau Cloud/Server: **Settings → Integrations** (Tableau Cloud) or the
   Slack integration settings, and choose **Connect to Slack**.
2. Authorize the **Tableau** Slack app into the target Slack **workspace**. A
   Slack workspace admin may need to approve the app install.
3. Confirm the connection shows **Connected** for that site.

> **Site-alignment gotcha (the usual failure):** the Slack connection is bound to
> **one specific Tableau site**. Alerts & subscriptions only deliver to Slack for
> content **on that same site**. If your data lives on site A but Slack is
> connected on site B, nothing arrives. Verify the connected site matches the
> site whose views/metrics users will subscribe to.

## Per-user: subscriptions

Any user (once the site is Slack-connected and they've linked their account):

1. Open a **view** or **workbook** → **Subscribe** (or Watch).
2. Choose **Slack** as the delivery channel and set the cadence.
3. They'll receive the rendered view in Slack on schedule.

## Per-user: data-driven alerts

1. On a view with a continuous axis, select a mark/axis → **Alerts** →
   **Create Alert**.
2. Set the threshold condition and choose **Slack** delivery.
3. Tableau sends a Slack message when the condition is met on refresh.

## Troubleshooting "notifications aren't arriving"

Work down this list — most failures are one of the first three:

1. **Wrong site.** The Slack integration is connected on a *different* Tableau
   site than the content. Re-check **Settings → Integrations** on the *content's*
   site. (This is the most common cause.)
2. **User hasn't linked Slack.** Each recipient must link their Tableau identity
   to Slack once (Tableau prompts them, or via their account settings).
3. **Slack app not approved** in the workspace, or the user isn't in the target
   workspace.
4. **No refresh / condition never met.** Subscriptions and alerts fire on data
   refresh; if the underlying extract doesn't refresh (e.g. a static `.hyper`
   upload with no refresh schedule), the trigger never occurs. Give the data
   source a refresh schedule, or use the agent's proactive brief instead.
5. **DND / notification prefs** in Slack suppressing the Tableau app's messages.

## When to use the agent instead

If the data source **can't be refresh-scheduled** (e.g. a direct `.hyper` upload
with no upstream), native subscriptions/alerts have nothing to fire on. In that
case the agent's **proactive brief** — driven by the EventBridge daily trigger
(`/jobs/vha-daily/<secret>`) or the refresh webhook — is the reliable path, since
its cadence is independent of Tableau's backgrounder.
