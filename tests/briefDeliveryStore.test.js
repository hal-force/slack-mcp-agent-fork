const { test } = require("node:test");
const assert = require("node:assert");
const store = require("../src/jobs/briefDeliveryStore");

/** Minimal in-memory fake of prisma.briefDelivery. */
function fakePrisma() {
  const rows = new Map();
  return {
    _rows: rows,
    briefDelivery: {
      async findUnique({ where: { id } }) { return rows.get(id) || null; },
      async upsert({ where: { id }, create, update }) {
        const existing = rows.get(id);
        const next = existing ? { ...existing, ...update } : { ...create };
        rows.set(id, next);
        return next;
      },
    },
  };
}

const snap = (over = {}) => ({
  metric_key: "SMR30", rag_status: "Red", value: "0.99",
  status_change: "Yellow->Red", alert_reason: "entered Red", ...over,
});

test("contentSignature is stable and changes when brief-worthy state changes", () => {
  const a = store.contentSignature(snap());
  const b = store.contentSignature(snap());
  assert.equal(a, b);
  assert.notEqual(a, store.contentSignature(snap({ value: "1.05" })));       // worsened value
  assert.notEqual(a, store.contentSignature(snap({ rag_status: "Yellow" }))); // band change
  // an irrelevant column does NOT change the signature
  assert.equal(a, store.contentSignature(snap({ vs_national_median: "whatever" })));
});

test("first send → not already sent; after mark → suppressed; worsened → resend", async (t) => {
  const p = fakePrisma();
  store.__setPrismaForTest(p);
  t.after(() => store.__setPrismaForTest(undefined));
  const base = { teamId: "T1", userId: "U_PHX_QM", periodMonth: "2026-07" };

  // 1. first time — nothing sent yet
  let sig = store.contentSignature(snap());
  let r = await store.wasSent({ ...base, metricKey: "SMR30", sig });
  assert.deepEqual(r, { alreadySent: false, changed: false });

  // deliver + mark
  await store.markSent({ ...base, facilityName: "Phoenix, AZ HCS", metricKey: "SMR30", sig });

  // 2. identical state → suppressed
  r = await store.wasSent({ ...base, metricKey: "SMR30", sig });
  assert.deepEqual(r, { alreadySent: true, changed: false });

  // 3. metric worsened (new sig) → resend
  const worseSig = store.contentSignature(snap({ value: "1.10" }));
  r = await store.wasSent({ ...base, metricKey: "SMR30", sig: worseSig });
  assert.deepEqual(r, { alreadySent: false, changed: true });
});

test("filterUnsent splits new/worsened from already-sent", async (t) => {
  const p = fakePrisma();
  store.__setPrismaForTest(p);
  t.after(() => store.__setPrismaForTest(undefined));
  const base = { teamId: "T1", userId: "U_PHX_QM", periodMonth: "2026-07" };

  const rows = [snap({ metric_key: "SMR30" }), snap({ metric_key: "OMELOS", value: "1.34" })];

  // Nothing sent yet → both to send
  let f = await store.filterUnsent({ ...base, rows });
  assert.equal(f.toSend.length, 2);
  assert.equal(f.suppressed.length, 0);

  // Mark SMR30 sent
  await store.markBatchSent({ ...base, facilityName: "Phoenix, AZ HCS", rows: [rows[0]], sigByMetric: f.sigByMetric });

  // Now SMR30 suppressed, OMELOS still to send
  f = await store.filterUnsent({ ...base, rows });
  assert.deepEqual(f.toSend.map((r) => r.metric_key), ["OMELOS"]);
  assert.deepEqual(f.suppressed.map((r) => r.metric_key), ["SMR30"]);
});

test("fail-open when no DB configured (Prisma null): never suppresses", async (t) => {
  store.__setPrismaForTest(null);
  t.after(() => store.__setPrismaForTest(undefined));
  const r = await store.wasSent({ teamId: "T1", userId: "U", metricKey: "SMR30", periodMonth: "2026-07", sig: "x" });
  assert.deepEqual(r, { alreadySent: false, changed: false });
  // markSent is a no-op that returns false, not a throw
  assert.equal(await store.markSent({ teamId: "T1", userId: "U", metricKey: "SMR30", periodMonth: "2026-07", sig: "x" }), false);
});

test("fail-open when the DB throws: lookup returns deliver, mark swallows error", async (t) => {
  store.__setPrismaForTest({
    briefDelivery: {
      async findUnique() { throw new Error("connection reset"); },
      async upsert() { throw new Error("connection reset"); },
    },
  });
  t.after(() => store.__setPrismaForTest(undefined));
  const r = await store.wasSent({ teamId: "T1", userId: "U", metricKey: "SMR30", periodMonth: "2026-07", sig: "x" });
  assert.deepEqual(r, { alreadySent: false, changed: false });
  assert.equal(await store.markSent({ teamId: "T1", userId: "U", metricKey: "SMR30", periodMonth: "2026-07", sig: "x" }), false);
});
