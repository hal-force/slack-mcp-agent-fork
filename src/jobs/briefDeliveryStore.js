/**
 * Durable dedupe / idempotency ledger for proactive VHA briefs.
 *
 * WHY (replaces the in-memory Set in vhaDailyBrief.run)
 *   The webhook (and the polling fallback) can fire many times for the same
 *   reporting month — Tableau retries non-2xx, an extract may refresh several
 *   times a day, the scheduler runs hourly. Without a durable record, a dyno
 *   restart wipes the in-memory guard and every user gets re-DMed. This ledger
 *   persists one row per (workspace, user, metric, reporting month) so a brief
 *   is sent AT MOST ONCE per meaningful state — across restarts and deploys.
 *
 * RE-BRIEF ON WORSENING, SUPPRESS ON STEADY
 *   The key is {teamId|userId|metricKey|periodMonth}; the row also stores a
 *   `contentSig` hash of the brief-worthy state (rag_status, value,
 *   status_change, alert_reason). A repeat trigger:
 *     • same key, same sig  → already delivered, SUPPRESS.
 *     • same key, new sig   → the metric moved again (e.g. slid further Red) →
 *                             DELIVER and update the row.
 *     • new key             → first time this month → DELIVER.
 *   This matches the alert_flag philosophy: trigger on the *delta*, stay quiet
 *   on the steady state.
 *
 * GRACEFUL DEGRADATION
 *   If the DB is unavailable (or DATABASE_URL is unset, as in a pure dry-run),
 *   the store is a NO-OP that reports "not yet sent" — the brief still goes out;
 *   we simply lose cross-run dedupe rather than blocking delivery. Prisma is
 *   lazy-required so importing this module in a dry-run/test never needs a DB.
 */

const crypto = require("crypto");

// The fields whose change should re-trigger a brief. Kept small + explicit so a
// noisy, irrelevant column (e.g. a recomputed median) doesn't cause re-briefs.
function contentSignature(snap) {
  const basis = [
    snap.rag_status,
    snap.value,
    snap.status_change,
    snap.alert_reason,
  ].map((v) => (v == null ? "" : String(v))).join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function keyFor({ teamId, userId, metricKey, periodMonth }) {
  return `${teamId || "-"}|${userId}|${metricKey}|${periodMonth}`;
}

let _prisma; // lazy singleton; null once we know the DB is unavailable
function getPrismaOrNull() {
  if (_prisma !== undefined) return _prisma;
  try {
    if (!process.env.DATABASE_URL) { _prisma = null; return _prisma; }
    _prisma = require("../install-kit/prisma").prisma;
  } catch (err) {
    console.warn(`[brief-store] Prisma unavailable, dedupe disabled: ${err?.message || err}`);
    _prisma = null;
  }
  return _prisma;
}

/**
 * Test seam: inject a fake Prisma client (briefDelivery.{findUnique,upsert}; claimBatch
 * also uses create/updateMany/deleteMany).
 */
function __setPrismaForTest(client) {
  _prisma = client === undefined ? undefined : client;
}

/**
 * Has this exact brief state already been delivered?
 * @returns {Promise<{alreadySent:boolean, changed:boolean}>}
 *   alreadySent=true  → an identical (same contentSig) brief exists → suppress.
 *   alreadySent=false, changed=true  → a prior brief exists but state moved.
 *   alreadySent=false, changed=false → never briefed this month.
 * On DB error, returns {alreadySent:false, changed:false} (fail-open: deliver).
 */
async function wasSent({ teamId, userId, metricKey, periodMonth, sig }) {
  const prisma = getPrismaOrNull();
  if (!prisma) return { alreadySent: false, changed: false };
  try {
    const row = await prisma.briefDelivery.findUnique({ where: { id: keyFor({ teamId, userId, metricKey, periodMonth }) } });
    if (!row) return { alreadySent: false, changed: false };
    if (row.contentSig === sig) return { alreadySent: true, changed: false };
    return { alreadySent: false, changed: true };
  } catch (err) {
    console.warn(`[brief-store] wasSent lookup failed (fail-open): ${err?.message || err}`);
    return { alreadySent: false, changed: false };
  }
}

/** Record (upsert) that a brief for this metric+month was delivered. Best-effort. */
async function markSent({ teamId, userId, facilityName, metricKey, periodMonth, sig }) {
  const prisma = getPrismaOrNull();
  if (!prisma) return false;
  const id = keyFor({ teamId, userId, metricKey, periodMonth });
  try {
    await prisma.briefDelivery.upsert({
      where: { id },
      create: { id, teamId: teamId || null, userId, facilityName: facilityName || null, metricKey, periodMonth, contentSig: sig },
      update: { contentSig: sig, facilityName: facilityName || null },
    });
    return true;
  } catch (err) {
    console.warn(`[brief-store] markSent upsert failed: ${err?.message || err}`);
    return false;
  }
}

/**
 * Given a user's selected metric rows, split them into those that should be
 * sent (new or worsened) and those to suppress (already delivered, unchanged).
 * Does NOT mark them sent — the caller marks only after a successful DM, so a
 * post failure doesn't permanently suppress the brief.
 *
 * @returns {Promise<{toSend: object[], suppressed: object[], sigByMetric: Map}>}
 */
async function filterUnsent({ teamId, userId, periodMonth, rows }) {
  const toSend = [];
  const suppressed = [];
  const sigByMetric = new Map();
  for (const snap of rows) {
    const sig = contentSignature(snap);
    sigByMetric.set(snap.metric_key, sig);
    const { alreadySent } = await wasSent({ teamId, userId, metricKey: snap.metric_key, periodMonth, sig });
    if (alreadySent) suppressed.push(snap);
    else toSend.push(snap);
  }
  return { toSend, suppressed, sigByMetric };
}

/** Mark a batch of rows as sent (after a successful DM). Best-effort per row. */
async function markBatchSent({ teamId, userId, facilityName, periodMonth, rows, sigByMetric }) {
  for (const snap of rows) {
    await markSent({
      teamId, userId, facilityName, metricKey: snap.metric_key, periodMonth,
      sig: sigByMetric?.get(snap.metric_key) || contentSignature(snap),
    });
  }
}

/**
 * Atomically CLAIM one metric's brief state before sending, so two concurrent
 * triggers (webhook retry + scheduler tick) can't both pass a read-then-write check
 * and double-DM. The primary key on `id` is the lock:
 *   • no row        → create(); a unique violation (P2002) means another run just
 *                     claimed it → re-check once against the row it wrote.
 *   • same sig      → already delivered → suppress.
 *   • different sig → compare-and-swap updateMany({ id, contentSig: <seen> }); a
 *                     count of 0 means another run moved it first → suppress.
 * Fail-open on DB errors (deliver), matching wasSent.
 * @returns {Promise<{claimed:boolean, prevSig:string|null}>}
 *   prevSig is the signature we replaced (null if we created the row) — release()
 *   needs it to undo the claim if the DM then fails.
 */
async function claimOne(prisma, { id, teamId, userId, facilityName, metricKey, periodMonth, sig }, retried = false) {
  const existing = await prisma.briefDelivery.findUnique({ where: { id } });
  if (!existing) {
    try {
      await prisma.briefDelivery.create({
        data: { id, teamId: teamId || null, userId, facilityName: facilityName || null, metricKey, periodMonth, contentSig: sig },
      });
      return { claimed: true, prevSig: null };
    } catch (err) {
      if (err && err.code === "P2002" && !retried) {
        return claimOne(prisma, { id, teamId, userId, facilityName, metricKey, periodMonth, sig }, true);
      }
      throw err;
    }
  }
  if (existing.contentSig === sig) return { claimed: false, prevSig: existing.contentSig };
  const { count } = await prisma.briefDelivery.updateMany({
    where: { id, contentSig: existing.contentSig },
    data: { contentSig: sig, facilityName: facilityName || null },
  });
  return { claimed: count === 1, prevSig: existing.contentSig };
}

/**
 * Claim-before-send replacement for filterUnsent + markBatchSent. Splits rows into
 * those this run now OWNS (send them) and those to suppress, and returns a
 * release() that rolls the claims back if delivery fails, so a failed DM retries on
 * the next run instead of being permanently suppressed.
 *
 * @returns {Promise<{toSend: object[], suppressed: object[], release: () => Promise<void>}>}
 */
async function claimBatch({ teamId, userId, facilityName, periodMonth, rows }) {
  const prisma = getPrismaOrNull();
  if (!prisma) return { toSend: rows.slice(), suppressed: [], release: async () => {} };

  const toSend = [];
  const suppressed = [];
  const claims = []; // { id, sig, prevSig } for rows we wrote
  for (const snap of rows) {
    const sig = contentSignature(snap);
    const id = keyFor({ teamId, userId, metricKey: snap.metric_key, periodMonth });
    try {
      const { claimed, prevSig } = await claimOne(prisma, {
        id, teamId, userId, facilityName, metricKey: snap.metric_key, periodMonth, sig,
      });
      if (claimed) {
        toSend.push(snap);
        claims.push({ id, sig, prevSig });
      } else {
        suppressed.push(snap);
      }
    } catch (err) {
      console.warn(`[brief-store] claim failed (fail-open): ${err?.message || err}`);
      toSend.push(snap);
    }
  }

  async function release() {
    for (const c of claims) {
      try {
        // Guarded on our own sig so we never clobber a newer claim by another run.
        if (c.prevSig == null) {
          await prisma.briefDelivery.deleteMany({ where: { id: c.id, contentSig: c.sig } });
        } else {
          await prisma.briefDelivery.updateMany({ where: { id: c.id, contentSig: c.sig }, data: { contentSig: c.prevSig } });
        }
      } catch (err) {
        console.warn(`[brief-store] release failed for ${c.id}: ${err?.message || err}`);
      }
    }
  }

  return { toSend, suppressed, release };
}

module.exports = {
  contentSignature,
  keyFor,
  wasSent,
  markSent,
  filterUnsent,
  markBatchSent,
  claimBatch,
  __setPrismaForTest,
};
