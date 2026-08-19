const { test } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const http = require("http");
const { registerTableauWebhook, safeEqual } = require("../src/jobs/tableauWebhook");

const quietLogger = { warn() {}, info() {}, error() {} };

/** Spin up an Express server with the webhook mounted; inject a stub job. */
async function withServer(t, { secret = "s3cr3t-demo", runFromRefresh } = {}) {
  const prev = process.env.TABLEAU_WEBHOOK_SECRET;
  if (secret === null) delete process.env.TABLEAU_WEBHOOK_SECRET;
  else process.env.TABLEAU_WEBHOOK_SECRET = secret;

  const app = express();
  const router = express.Router();
  app.use(router);
  const calls = [];
  const { mounted } = registerTableauWebhook(
    { router },
    { logger: quietLogger, runFromRefresh: runFromRefresh || (async (p) => { calls.push(p); return { triggered: true, result: { sent: 1 } }; }) },
  );

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  t.after(() => {
    server.close();
    if (prev === undefined) delete process.env.TABLEAU_WEBHOOK_SECRET;
    else process.env.TABLEAU_WEBHOOK_SECRET = prev;
  });

  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, text: await res.text() };
  };

  return { mounted, calls, post };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test("does not arm without a secret", async (t) => {
  const { mounted } = await withServer(t, { secret: null });
  assert.equal(mounted, false);
});

test("rejects a bad secret with 404 and does not dispatch", async (t) => {
  const { post, calls } = await withServer(t);
  const res = await post("/webhooks/tableau/refresh/WRONG", {
    event_type: "DatasourceRefreshSucceeded",
    resource_name: "VHA Metric Snapshots",
  });
  assert.equal(res.status, 404);
  await tick();
  assert.equal(calls.length, 0);
});

test("acks the empty test-ping with 200 and dispatches (job ignores it)", async (t) => {
  const seen = [];
  const { post } = await withServer(t, { runFromRefresh: async (p) => { seen.push(p); return { triggered: false, reason: "empty payload (webhook test)" }; } });
  const res = await post("/webhooks/tableau/refresh/s3cr3t-demo", {});
  assert.equal(res.status, 200);
  await tick();
  // Handler still hands the empty payload down; the job is what no-ops it.
  assert.deepEqual(seen, [{}]);
});

test("acks a real refresh with 200 and dispatches the payload", async (t) => {
  const { post, calls } = await withServer(t);
  const payload = {
    resource: "EXTRACTS",
    event_type: "DatasourceRefreshSucceeded",
    resource_name: "VHA Metric Snapshots",
    resource_luid: "7b92fd7b-cdc2-4142-8594-ecb77a827be9",
    site_luid: "abc",
    created_at: "2026-08-19T12:00:00Z",
  };
  const res = await post("/webhooks/tableau/refresh/s3cr3t-demo", payload);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resource_name, "VHA Metric Snapshots");
});

test("safeEqual is correct and length-safe", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false); // differing length → false, no throw
  assert.equal(safeEqual("", ""), true);
});

// --- job-level filtering (runFromRefresh decision logic) ---
const { runFromRefresh, isTriggeringRefresh } = require("../src/jobs/vhaDailyBrief");

test("isTriggeringRefresh matches snapshots by name or luid, not dimensions", () => {
  assert.equal(isTriggeringRefresh({ resource_name: "VHA Metric Snapshots" }), true);
  assert.equal(isTriggeringRefresh({ resource_luid: "7b92fd7b-cdc2-4142-8594-ecb77a827be9" }), true);
  assert.equal(isTriggeringRefresh({ resource_name: "vha metric snapshots" }), true); // case-insensitive
  assert.equal(isTriggeringRefresh({ resource_name: "VHA Facilities" }), false);
  assert.equal(isTriggeringRefresh({}), false);
});

test("runFromRefresh ignores non-Succeeded events and empty payloads", async () => {
  assert.equal((await runFromRefresh({})).triggered, false);
  assert.equal((await runFromRefresh({ event_type: "DatasourceRefreshStarted", resource_name: "VHA Metric Snapshots" })).triggered, false);
  assert.equal((await runFromRefresh({ event_type: "DatasourceRefreshFailed", resource_name: "VHA Metric Snapshots" })).triggered, false);
  assert.equal((await runFromRefresh({ event_type: "DatasourceRefreshSucceeded", resource_name: "VHA Facilities" })).triggered, false);
});
