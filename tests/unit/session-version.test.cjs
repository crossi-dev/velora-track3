/**
 * session-version.test.cjs
 *
 * Unit tests for the auth-session-version helper.
 * All DB calls are mocked — no real Postgres connection required.
 */

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-session-version-secret-32b!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  clearMockModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ─── Prisma mock ─────────────────────────────────────────────────────────────
// Use setMockModule so this file's @/lib/prisma mock takes priority in the
// shared mocks map, regardless of what any previously-loaded test file left
// behind (e.g. a partial mock from rate-limit-token-bucket.test.cjs).

/** @type {Record<string, number>} in-memory fake DB for User.sessionVersion */
const fakeDb = {};

const prismaMock = {
  user: {
    async findUnique({ where, select }) {
      const version = fakeDb[where.id];
      if (version === undefined) return null;
      if (select?.sessionVersion) return { sessionVersion: version };
      return { id: where.id, sessionVersion: version };
    },
    async update({ where, data }) {
      if (fakeDb[where.id] === undefined) {
        throw new Error(`User ${where.id} not found`);
      }
      if (data.sessionVersion?.increment) {
        fakeDb[where.id] += data.sessionVersion.increment;
      }
      return { id: where.id, sessionVersion: fakeDb[where.id] };
    },
  },
};

// Register our own @/lib/prisma mock so the shared Module._load interceptor
// returns it correctly — taking priority over any stale mock left by a prior
// file (e.g. rate-limit-token-bucket.test.cjs's partial prisma mock).
clearMockModules();
setMockModule("@/lib/prisma", { prisma: prismaMock });

const {
  getUserSessionVersion,
  invalidateUserSession,
  _testOnly,
} = require("../../src/lib/auth-session-version.ts");

const { cacheGet, cacheSet, cacheEvict, versionCache } = _testOnly;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seed(userId, version = 1) {
  fakeDb[userId] = version;
  cacheEvict(userId); // start with cold cache
}

function clearDb(userId) {
  delete fakeDb[userId];
  cacheEvict(userId);
}

// ─── Cache unit tests ─────────────────────────────────────────────────────────

test("cacheGet: returns undefined on cold cache", () => {
  assert.equal(cacheGet("u-cold"), undefined);
});

test("cacheSet/cacheGet: round-trip", () => {
  cacheSet("u-rtt", 3);
  assert.equal(cacheGet("u-rtt"), 3);
  cacheEvict("u-rtt");
});

test("cacheGet: returns undefined after eviction", () => {
  cacheSet("u-evict", 7);
  cacheEvict("u-evict");
  assert.equal(cacheGet("u-evict"), undefined);
});

// ─── getUserSessionVersion ────────────────────────────────────────────────────

test("getUserSessionVersion: returns version from DB on cache miss", async () => {
  seed("u-db-miss", 1);
  const v = await getUserSessionVersion("u-db-miss");
  assert.equal(v, 1);
  clearDb("u-db-miss");
});

test("getUserSessionVersion: returns null for deleted user", async () => {
  clearDb("u-deleted");
  const v = await getUserSessionVersion("u-deleted");
  assert.equal(v, null);
});

test("getUserSessionVersion: subsequent call uses cache (no DB)", async () => {
  seed("u-cached", 2);
  // First call — populates cache
  await getUserSessionVersion("u-cached");
  // Corrupt DB to confirm second call uses cache
  fakeDb["u-cached"] = 999;
  const v = await getUserSessionVersion("u-cached");
  assert.equal(v, 2, "should return cached value, not DB corruption");
  clearDb("u-cached");
});

// ─── invalidateUserSession ────────────────────────────────────────────────────

test("invalidateUserSession: increments DB version", async () => {
  seed("u-incr", 1);
  await invalidateUserSession("u-incr");
  assert.equal(fakeDb["u-incr"], 2);
  clearDb("u-incr");
});

test("invalidateUserSession: evicts cache", async () => {
  seed("u-evict-inv", 1);
  cacheSet("u-evict-inv", 1); // warm cache
  await invalidateUserSession("u-evict-inv");
  assert.equal(cacheGet("u-evict-inv"), undefined, "cache must be evicted");
  clearDb("u-evict-inv");
});

test("invalidateUserSession: next getUserSessionVersion reads new DB value", async () => {
  seed("u-reread", 1);
  await invalidateUserSession("u-reread");
  const v = await getUserSessionVersion("u-reread");
  assert.equal(v, 2);
  clearDb("u-reread");
});

// ─── Session invalidation scenario ───────────────────────────────────────────
// Simulates the JWT callback logic: token has version=1, DB bumped to 2.

test("scenario: token version mismatch forces logout", async () => {
  seed("u-scenario", 1);
  const tokenVersion = 1;

  // Simulate JWT callback on login: embed version
  const embeddedVersion = await getUserSessionVersion("u-scenario");
  assert.equal(embeddedVersion, tokenVersion, "fresh login embeds correct version");

  // Admin invalidates the session
  await invalidateUserSession("u-scenario");

  // Simulate JWT callback on next request: compare token vs DB
  const dbVersion = await getUserSessionVersion("u-scenario");
  assert.equal(dbVersion, 2, "DB version bumped");
  assert.notEqual(dbVersion, tokenVersion, "mismatch → return null (force logout)");

  clearDb("u-scenario");
});

test("scenario: re-login after invalidation embeds new version", async () => {
  seed("u-relogin", 2);
  const newVersion = await getUserSessionVersion("u-relogin");
  assert.equal(newVersion, 2, "new JWT embeds updated version");
  clearDb("u-relogin");
});

test("scenario: user deleted mid-session", async () => {
  seed("u-del-mid", 1);
  clearDb("u-del-mid"); // simulate deletion
  const v = await getUserSessionVersion("u-del-mid");
  assert.equal(v, null, "null → JWT callback returns null → force logout");
});
