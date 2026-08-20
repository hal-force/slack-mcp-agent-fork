const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  METRIC_VIEWS,
  metricView,
  viewDeepLink,
  viewFiltersForFacility,
} = require("../src/jobs/vhaMetricViews");

const fs = require("fs");
const path = require("path");
const { parseCsv } = require("../src/jobs/vhaLocalizedDigest");

test("every registry metric maps to a view (and no orphan mappings)", () => {
  const registry = parseCsv(
    fs.readFileSync(path.join(__dirname, "..", "demo-data", "vha", "vha_metric_registry.csv"), "utf8"),
  );
  const registryKeys = new Set(registry.map((m) => m.metric_key));
  // Each metric the brief can flag has a view.
  for (const key of registryKeys) {
    assert.ok(METRIC_VIEWS[key], `registry metric ${key} has no view mapping`);
  }
  // Each mapping points at a registry metric (no stale keys).
  for (const key of Object.keys(METRIC_VIEWS)) {
    assert.ok(registryKeys.has(key), `view mapping ${key} is not a registry metric`);
  }
});

test("metricView returns a viewId+contentUrl for a known metric, null otherwise", () => {
  const v = metricView("SMR30");
  assert.ok(v && v.viewId && v.contentUrl);
  assert.equal(metricView("NOPE"), null);
});

test("viewDeepLink builds a browse URL and drops the /sheets/ segment", () => {
  const link = viewDeepLink("VHAMetricsViewsandDashboards/sheets/MetricTargetSelect-SMR30");
  assert.match(link, /\/site\/usfederaldemos\/views\/VHAMetricsViewsandDashboards\/MetricTargetSelect-SMR30$/);
  assert.doesNotMatch(link, /\/sheets\//);
  assert.equal(viewDeepLink(null), null);
});

test("viewFiltersForFacility is empty today (views default to Phoenix)", () => {
  // The single hook for the future facility parameter; currently no filter.
  assert.deepEqual(viewFiltersForFacility("Phoenix, AZ HCS"), {});
  assert.deepEqual(viewFiltersForFacility("Tucson, AZ HCS"), {});
});
