const { test } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const http = require("http");
const { registerDailyBriefTrigger } = require("../src/jobs/dailyBriefTrigger");

const quietLogger = { warn() {}, info() {}, error() {} };

/** Spin up an Express server with the trigger mounted; inject a stub run(). */
async function withServer(t, { secret = "s3cr3t-daily", run } = {}) {
  const prev = process.env.VHA_DAILY_JOB_SECRET;
  if (secret === null) delete process.env.VHA_DAILY_JOB_SECRET;
  else process.env.VHA_DAILY_JOB_SECRET = secret;

  const app = express();
  const router = express.Router();
  app.use(router);
  const calls = [];
  const { mounted } = registerDailyBriefTrigger(
    { router },
    { logger: quietLogger, run: run || (async (opts) => { calls.push(opts); return { sent: 1 }; }) },
  );

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  t.after(() => {
    server.close();
    if (prev === undefined) delete process.env.VHA_DAILY_JOB_SECRET;
    else process.env.VHA_DAILY_JOB_SECRET = prev;
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
  const res = await post("/jobs/vha-daily/WRONG", {});
  assert.equal(res.status, 404);
  await tick();
  assert.equal(calls.length, 0);
});

test("acks a valid trigger with 200 and runs a deduped, hour-gate-off scan", async (t) => {
  const { post, calls } = await withServer(t);
  const res = await post("/jobs/vha-daily/s3cr3t-daily", {});
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true });
  await tick();
  assert.equal(calls.length, 1);
  // Must invoke the same shape as the `--daily` CLI flag.
  assert.equal(calls[0].ignoreHour, true);
  assert.equal(calls[0].dedupe, true);
});
