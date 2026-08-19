#!/usr/bin/env python3
"""
VHA Localized Metric Review — live query battery / demo flow.

Runs a set of realistic "localized metric review" questions as VizQL Data
Service queries against the four data sources published to
usfederaldemos -> "VA | Veterans Affairs". Doubles as:

  1. A SMOKE TEST — proves each published source is queryable and that the
     temporal/alert columns (alert_flag, as_of_date, status_change, ...)
     answer the questions the Slack agent will actually ask.
  2. A DEMO SCRIPT — each QUESTION mirrors a thing an administrator would
     type at the agent ("what's off target at my facility this month, and
     why?"). The VizQL query is exactly what the agent's query-datasource
     MCP tool would emit; the printed rows are the ground truth it would
     narrate.

Auth comes from the tableau-prep-etl skill's credential discovery (env ->
Keychain). No secret is read or printed here.

    python3 demo-data/vha/mcp_demo_queries.py
"""
import json
import sys
import requests

# Bootstrap the skill's credential discovery + sign-in.
sys.path.insert(0, __import__("os").path.expanduser("~/claude-projects/tableau-prep-etl-skill"))
from skill.scripts import server_creds          # noqa: E402
from tflb_lib import publishing                  # noqa: E402

# LUIDs of the four sources published to VA | Veterans Affairs.
DS = {
    "snapshots": "7b92fd7b-cdc2-4142-8594-ecb77a827be9",
    "plans":     "99c7c8b6-eb46-498e-a151-c0823cc34cdc",
    "facilities":"05312d4e-4a22-487c-bc6d-a67ef0174a2f",
    "registry":  "8f23add7-a97e-4c79-bd3a-6125831e81d3",
}

LATEST = "2026-07"
FACILITY = "Phoenix, AZ HCS"   # the "struggling" archetype — good demo subject


def _set(field, values, exclude=False):
    return {"field": {"fieldCaption": field}, "filterType": "SET",
            "values": values, "exclude": exclude}


# IMPORTANT (VizQL Data Service gotcha): a SET filter on a BOOLEAN field must
# use a JSON boolean, NOT the string "true". Passing "true" fails with
# 400803 "Unable to convert value true for Filter on Field alert_flag".
# The agent's query-datasource tool must emit `true`/`false`, not "true".
ALERT_TRUE = _set("alert_flag", [True])


# Each entry: (question the admin asks, datasource key, VizQL query dict).
# The query is what the agent's query-datasource tool call would contain.
QUESTIONS = [
    ("Q1. Which facilities have an alert THIS MONTH, and why? (the daily trigger)",
     "snapshots",
     {"fields": [
         {"fieldCaption": "facility_name"},
         {"fieldCaption": "metric_caption"},
         {"fieldCaption": "rag_status"},
         {"fieldCaption": "status_change"},
         {"fieldCaption": "alert_reason"},
      ],
      "filters": [_set("period_month", [LATEST]), ALERT_TRUE]}),

    (f"Q2. Rank {FACILITY}'s metrics by how far off target they are (latest month)",
     "snapshots",
     {"fields": [
         {"fieldCaption": "metric_caption"},
         {"fieldCaption": "value", "function": "SUM"},
         {"fieldCaption": "target", "function": "SUM"},
         {"fieldCaption": "pct_to_target", "function": "SUM"},
         {"fieldCaption": "rag_status"},
      ],
      "filters": [_set("facility_name", [FACILITY]), _set("period_month", [LATEST])]}),

    (f"Q3. {FACILITY} SMR30 trend — value by month (the 'what changed' line)",
     "snapshots",
     {"fields": [
         {"fieldCaption": "period_month"},
         {"fieldCaption": "value", "function": "SUM"},
         {"fieldCaption": "rag_status"},
      ],
      "filters": [_set("facility_name", [FACILITY]), _set("metric_key", ["SMR30"])]}),

    (f"Q4. Is {FACILITY} SMR30 bad vs peers? (VISN + national benchmark, latest)",
     "snapshots",
     {"fields": [
         {"fieldCaption": "value", "function": "SUM"},
         {"fieldCaption": "visn_median", "function": "SUM"},
         {"fieldCaption": "national_median", "function": "SUM"},
         {"fieldCaption": "vs_visn_median", "function": "SUM"},
         {"fieldCaption": "vs_national_median", "function": "SUM"},
      ],
      "filters": [_set("facility_name", [FACILITY]), _set("metric_key", ["SMR30"]),
                  _set("period_month", [LATEST])]}),

    ("Q5. National picture — how many facilities are Red per metric this month?",
     "snapshots",
     {"fields": [
         {"fieldCaption": "metric_caption"},
         {"fieldCaption": "facility_name", "function": "COUNT"},
      ],
      "filters": [_set("period_month", [LATEST]), _set("rag_status", ["Red"])]}),

    ("Q6. Fresh band crossings this month (exclude steady Red->Red)",
     "snapshots",
     {"fields": [
         {"fieldCaption": "facility_name"},
         {"fieldCaption": "metric_caption"},
         {"fieldCaption": "status_change"},
         {"fieldCaption": "direction_of_change"},
      ],
      "filters": [_set("period_month", [LATEST]), ALERT_TRUE,
                  _set("status_change", ["Red->Red"], exclude=True)]}),

    (f"Q7. So-what: the linked action plan for {FACILITY} SMR30 (owner, barriers)",
     "plans",
     {"fields": [
         {"fieldCaption": "status"},
         {"fieldCaption": "assignee_function"},
         {"fieldCaption": "owning_channel"},
         {"fieldCaption": "barriers"},
         {"fieldCaption": "progress_note"},
      ],
      "filters": [_set("facility_name", [FACILITY]), _set("metric_key", ["SMR30"])]}),

    ("Q8. Routing: which Slack channel + function owns each metric?",
     "registry",
     {"fields": [
         {"fieldCaption": "metric_caption"},
         {"fieldCaption": "owning_channel"},
         {"fieldCaption": "owning_function"},
      ]}),

    (f"Q9. Location context: who directs {FACILITY}, and what VISN/region?",
     "facilities",
     {"fields": [
         {"fieldCaption": "facility_name"},
         {"fieldCaption": "director_name"},
         {"fieldCaption": "director_user"},
         {"fieldCaption": "visn"},
         {"fieldCaption": "region"},
      ],
      "filters": [_set("facility_name", [FACILITY])]}),
]


def main():
    server_creds.discover()
    cfg = publishing.config_from_env()
    srv = publishing.sign_in(cfg)
    base = cfg.url.rstrip("/")
    H = {"X-Tableau-Auth": srv.auth_token, "Content-Type": "application/json",
         "Accept": "application/json"}
    url = f"{base}/api/v1/vizql-data-service/query-datasource"

    passed = 0
    try:
        for q_label, ds_key, query in QUESTIONS:
            payload = {"datasource": {"datasourceLuid": DS[ds_key]}, "query": query}
            try:
                r = requests.post(url, headers=H, json=payload, timeout=60)
            except Exception as e:
                print(f"\n{q_label}\n  ERROR (network): {type(e).__name__}: {e}")
                continue
            print(f"\n{q_label}\n  [{ds_key}] HTTP {r.status_code}", end="")
            if not r.ok:
                print(f"\n  FAIL: {r.text[:300]}")
                continue
            rows = r.json().get("data", [])
            print(f" | {len(rows)} rows")
            for row in rows[:8]:
                # compact one-line render
                print("   ", json.dumps(row, ensure_ascii=False))
            if len(rows) > 8:
                print(f"    ... (+{len(rows)-8} more)")
            if rows:
                passed += 1
            else:
                print("  WARN: 0 rows")
    finally:
        srv.auth.sign_out()

    print(f"\n===== {passed}/{len(QUESTIONS)} questions returned data =====")
    return 0 if passed == len(QUESTIONS) else 1


if __name__ == "__main__":
    sys.exit(main())
