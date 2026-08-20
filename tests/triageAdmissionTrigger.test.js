const { test } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const http = require("http");
const { registerTriageAdmissionTrigger } = require("../src/jobs/triageAdmissionTrigger");

const quietLogger = { warn() {}, info() {}, error() {} };

async function withServer(t, { secret = "s3cr3t-adm", agentsEnabled = "1", handleAdmission, app } = {}) {
  const prevSecret = process.env.TRIAGE_ADMISSION_SECRET;
  const prevAgents = process.env.AGENTS_ENABLED;
  const prevChan = process.env.TRIAGE_CHANNEL_ID;
  if (secret === null) delete process.env.TRIAGE_ADMISSION_SECRET;
  else process.env.TRIAGE_ADMISSION_SECRET = secret;
  if (agentsEnabled === null) delete process.env.AGENTS_ENABLED;
  else process.env.AGENTS_ENABLED = agentsEnabled;
  process.env.TRIAGE_CHANNEL_ID = "C_TRIAGE_DEFAULT";

  const expressApp = express();
  const router = express.Router();
  expressApp.use(router);
  const calls = [];
  const boltApp = app || { client: { chat: { postMessage: async (m) => { return { ok: true, ts: "1", _m: m }; } } } };
  const { mounted } = registerTriageAdmissionTrigger(
    { router },
    {
      logger: quietLogger,
      app: boltApp,
      handleAdmission:
        handleAdmission ||
        (async (params, deps) => {
          calls.push({ params, deps });
          // exercise the injected poster so tests can see channel posting happen
          await deps.postMessage({ channel: params.channel, text: "notice", blocks: [] });
          return { ranking: [{ nurse_id: "RN1" }] };
        }),
    },
  );

  const server = http.createServer(expressApp);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  t.after(() => {
    server.close();
    if (prevSecret === undefined) delete process.env.TRIAGE_ADMISSION_SECRET;
    else process.env.TRIAGE_ADMISSION_SECRET = prevSecret;
    if (prevAgents === undefined) delete process.env.AGENTS_ENABLED;
    else process.env.AGENTS_ENABLED = prevAgents;
    if (prevChan === undefined) delete process.env.TRIAGE_CHANNEL_ID;
    else process.env.TRIAGE_CHANNEL_ID = prevChan;
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
  const res = await post("/triage/admission/WRONG", { patient_id: "PT1" });
  assert.equal(res.status, 404);
  await tick();
  assert.equal(calls.length, 0);
});

test("refuses to post when AGENTS_ENABLED is off (409)", async (t) => {
  const { post, calls } = await withServer(t, { agentsEnabled: "0" });
  const res = await post("/triage/admission/s3cr3t-adm", { patient_id: "PT1", channel: "C1" });
  assert.equal(res.status, 409);
  await tick();
  assert.equal(calls.length, 0);
});

test("requires patient_id (400)", async (t) => {
  const { post } = await withServer(t);
  const res = await post("/triage/admission/s3cr3t-adm", { channel: "C1" });
  assert.equal(res.status, 400);
  assert.match(res.text, /patient_id/);
});

test("acks 200 and dispatches handleAdmission with defaulted channel", async (t) => {
  const { post, calls } = await withServer(t);
  const res = await post("/triage/admission/s3cr3t-adm", { patient_id: "PT0123", unit: "ICU-A" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true, patient_id: "PT0123", channel: "C_TRIAGE_DEFAULT" });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.patientId, "PT0123");
  assert.equal(calls[0].params.channel, "C_TRIAGE_DEFAULT");
  assert.equal(calls[0].params.unit, "ICU-A");
  // The injected poster is a real function wired to the Bolt client.
  assert.equal(typeof calls[0].deps.postMessage, "function");
});

test("explicit channel in the body overrides the default", async (t) => {
  const { post, calls } = await withServer(t);
  await post("/triage/admission/s3cr3t-adm", { patient_id: "PT9", channel: "C_OVERRIDE" });
  await tick();
  assert.equal(calls[0].params.channel, "C_OVERRIDE");
});
