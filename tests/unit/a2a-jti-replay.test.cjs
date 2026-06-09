// Unit tests — A2A JTI replay-protection cache.
//
// markJtiSeen() inserts a jti into A2aJtiSeen. A P2002 unique violation
// means replay. DB errors fail-closed (also reject). Expired rows are
// eligible for cleanup by the audit-cleanup cron.

"use strict";

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-a2a-jti-replay-secret-32bytes!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── In-memory JTI store ────────────────────────────────────────────────────────

const jtiStore = new Map(); // jti → expiresAt

function makePrismaMock(opts = {}) {
  return {
    a2aJtiSeen: {
      create: async ({ data }) => {
        if (opts.throwDbError) {
          const err = new Error("Connection refused");
          err.code = "P1001";
          throw err;
        }
        if (jtiStore.has(data.jti)) {
          const err = new Error("Unique constraint violation on jti");
          err.code = "P2002";
          throw err;
        }
        jtiStore.set(data.jti, data.expiresAt);
        return { jti: data.jti, expiresAt: data.expiresAt };
      },
      deleteMany: async ({ where }) => {
        if (!where?.expiresAt?.lt) return { count: 0 };
        const cutoff = where.expiresAt.lt;
        let count = 0;
        for (const [jti, expiresAt] of jtiStore) {
          if (expiresAt < cutoff) {
            jtiStore.delete(jti);
            count++;
          }
        }
        return { count };
      },
    },
  };
}

// ── Load markJtiSeen with mocked prisma ───────────────────────────────────────

function loadCache(opts = {}) {
  jtiStore.clear();
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma", { prisma: makePrismaMock(opts) });
  return require("../../src/lib/a2a-jti-cache.ts");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("JTI replay: first call with fresh jti → accepted (no throw)", async () => {
  const { markJtiSeen } = loadCache();
  const jti = crypto.randomUUID();
  const expSec = Math.floor(Date.now() / 1000) + 60;
  // Should not throw
  await assert.doesNotReject(() => markJtiSeen(jti, expSec));
  assert.ok(jtiStore.has(jti), "jti must be stored");
});

test("JTI replay: second call with same jti → throws P2002 (replay detected)", async () => {
  const { markJtiSeen } = loadCache();
  const jti = crypto.randomUUID();
  const expSec = Math.floor(Date.now() / 1000) + 60;
  await markJtiSeen(jti, expSec);
  await assert.rejects(
    () => markJtiSeen(jti, expSec),
    (err) => {
      assert.equal(err.code, "P2002", "error code must be P2002 for unique violation");
      return true;
    }
  );
});

test("JTI replay: expired rows are eligible for cleanup (deleteMany by expiresAt)", async () => {
  const { markJtiSeen } = loadCache();

  // Insert two JTIs: one expired, one still valid
  const expiredJti = crypto.randomUUID();
  const freshJti = crypto.randomUUID();
  const nowMs = Date.now();
  const pastExpSec = Math.floor(nowMs / 1000) - 120; // 2 minutes ago
  const futureExpSec = Math.floor(nowMs / 1000) + 60;  // 1 minute ahead

  await markJtiSeen(expiredJti, pastExpSec);
  await markJtiSeen(freshJti, futureExpSec);

  assert.equal(jtiStore.size, 2);

  // Simulate the cleanup cron: delete where expiresAt < now
  const deleted = await makePrismaMock().a2aJtiSeen.deleteMany({
    where: { expiresAt: { lt: new Date(nowMs) } },
  });

  assert.equal(deleted.count, 1, "should delete only the expired row");
  assert.ok(!jtiStore.has(expiredJti), "expired JTI must be removed");
  assert.ok(jtiStore.has(freshJti), "fresh JTI must remain");
});

test("JTI replay: DB error (non-P2002) → throws (fail-closed)", async () => {
  const { markJtiSeen } = loadCache({ throwDbError: true });
  const jti = crypto.randomUUID();
  const expSec = Math.floor(Date.now() / 1000) + 60;
  await assert.rejects(
    () => markJtiSeen(jti, expSec),
    (err) => {
      // Must NOT silently swallow — must propagate the DB error
      assert.ok(err.code !== "P2002", "non-P2002 error must propagate unchanged");
      return true;
    }
  );
});

test("JTI replay: expiresAt is derived from the JWT exp claim", async () => {
  const { markJtiSeen } = loadCache();
  const jti = crypto.randomUUID();
  const expSec = 1800000000; // far future Unix timestamp
  await markJtiSeen(jti, expSec);
  const stored = jtiStore.get(jti);
  assert.ok(stored instanceof Date, "expiresAt must be stored as Date");
  assert.equal(stored.getTime(), expSec * 1000, "expiresAt must equal expSec * 1000");
});
