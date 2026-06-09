// RLS Tenant Extension — unit tests
//
// Verifies the behaviour of runWithTenantContext + getTenantBusinessId
// (src/lib/tenant-context.ts) and the cross-tenant isolation contract that
// the Prisma extension enforces.
//
// These tests do NOT talk to a real database — they mock the Prisma $transaction
// and $executeRawUnsafe calls to verify:
//   1. When inside a tenant context, SET LOCAL is issued with the correct businessId.
//   2. When outside a tenant context (cron scope), no SET LOCAL is issued.
//   3. Concurrent async contexts do not bleed businessId into each other
//      (the core AsyncLocalStorage safety guarantee for request isolation).
//   4. SQL injection is neutralised by the single-quote escape.
//   5. Business A cannot read Business B's data when the extension enforces
//      the correct context (simulated cross-tenant scenario).

const assert = require("node:assert/strict");
const test = require("node:test");

// Require the tenant-context module directly (TypeScript via register.cjs transpile).
const {
  runWithTenantContext,
  getTenantBusinessId,
} = require("../../src/lib/tenant-context.ts");

// ── 1. Basic context propagation ─────────────────────────────────────────────

test("getTenantBusinessId returns undefined outside any context", () => {
  const id = getTenantBusinessId();
  assert.equal(id, undefined);
});

test("getTenantBusinessId returns the bound businessId inside runWithTenantContext", async () => {
  let captured;
  await runWithTenantContext("biz_A", async () => {
    captured = getTenantBusinessId();
  });
  assert.equal(captured, "biz_A");
});

test("getTenantBusinessId returns undefined after the context exits", async () => {
  await runWithTenantContext("biz_A", async () => {});
  assert.equal(getTenantBusinessId(), undefined);
});

// ── 2. Concurrent isolation (the core safety property) ───────────────────────

test("concurrent tenant contexts do not bleed into each other", async () => {
  const results = [];

  // Simulate two concurrent requests with different tenants.
  await Promise.all([
    runWithTenantContext("biz_concurrent_A", async () => {
      // Simulate async work (I/O, DB call).
      await new Promise((r) => setTimeout(r, 10));
      results.push({ label: "A", id: getTenantBusinessId() });
    }),
    runWithTenantContext("biz_concurrent_B", async () => {
      await new Promise((r) => setTimeout(r, 5));
      results.push({ label: "B", id: getTenantBusinessId() });
    }),
  ]);

  const a = results.find((r) => r.label === "A");
  const b = results.find((r) => r.label === "B");
  assert.equal(a.id, "biz_concurrent_A", "context A must see its own businessId");
  assert.equal(b.id, "biz_concurrent_B", "context B must see its own businessId");
});

// ── 3. Real extension behaviour (exercises applyTenantIsolation directly) ─────
//
// Previous versions used a `simulateExtension` helper that re-implemented the
// extension logic inline and diverged from the real code (e.g., it omitted
// SET LOCAL statement_timeout). These tests call the exported
// `applyTenantIsolation` function — the same function wired into the Prisma
// extension — so assertions stay in sync with production behaviour automatically.
//
// Flag handling:
//   RLS_ACTIVE is a module-level constant read at load time. To test both flag
//   states we set process.env.RLS_SESSION_CONTEXT_ENABLED and re-require the
//   module with a fresh cache entry via the exported `applyTenantIsolation`.
//   This preserves the module-load security-gate intent (the value is fixed at
//   load time; cannot be toggled per-request in production) while letting unit
//   tests cover both branches.

const EXTENSION_MODULE_PATH = require.resolve(
  "../../src/lib/prisma-tenant-extension.ts",
);

function requireIsolationFnWithFlag(flagValue) {
  // Clear the cached module so the new env value is picked up at load time.
  delete require.cache[EXTENSION_MODULE_PATH];
  if (flagValue === true) {
    process.env.RLS_SESSION_CONTEXT_ENABLED = "true";
  } else {
    delete process.env.RLS_SESSION_CONTEXT_ENABLED;
  }
  const mod = require("../../src/lib/prisma-tenant-extension.ts");
  return mod.applyTenantIsolation;
}

function makeMockBase() {
  const statements = [];
  const mockTx = {
    $executeRawUnsafe: async (sql) => { statements.push(sql); },
  };
  let transactionCalled = false;
  const mockBase = {
    $transaction: async (fn) => {
      transactionCalled = true;
      return fn(mockTx);
    },
    get $transactionCalled() { return transactionCalled; },
  };
  return { mockBase, statements };
}

// ── 3a. Flag OFF (RLS_SESSION_CONTEXT_ENABLED unset) ─────────────────────────
//
// When the flag is OFF the extension must be a TRUE global pass-through:
// $transaction is NOT called and ZERO SET LOCAL statements are issued, even
// when a tenant context IS set. This is the key regression-proof for FIX W-1:
// deploying this PR with the flag OFF must be byte-identical to origin/main.

test("flag OFF + tenant context: zero SET LOCAL, no $transaction (true pass-through)", async () => {
  const applyFn = requireIsolationFnWithFlag(false);
  const { mockBase, statements } = makeMockBase();

  let queryReceived;
  const fakeArgs = { where: { businessId: "biz_A" } };

  await runWithTenantContext("biz_A", async () => {
    await applyFn(mockBase, fakeArgs, async (a) => { queryReceived = a; return "ok"; });
  });

  assert.equal(statements.length, 0, "flag OFF must issue ZERO SET LOCAL statements");
  assert.equal(mockBase.$transactionCalled, false, "flag OFF must NOT open a $transaction");
  assert.deepEqual(queryReceived, fakeArgs, "query must receive the original args unchanged");
});

test("flag OFF + no tenant context (cron): zero SET LOCAL, no $transaction", async () => {
  const applyFn = requireIsolationFnWithFlag(false);
  const { mockBase, statements } = makeMockBase();

  let queryCalled = false;
  await applyFn(mockBase, {}, async () => { queryCalled = true; return []; });

  assert.equal(statements.length, 0, "no SET LOCAL for cron scope with flag OFF");
  assert.equal(mockBase.$transactionCalled, false, "no $transaction for cron scope with flag OFF");
  assert.ok(queryCalled, "query must still be called");
});

// ── 3b. Flag ON (RLS_SESSION_CONTEXT_ENABLED=true) ───────────────────────────
//
// When the flag is ON and a tenant context is present, exactly 3 SET LOCAL
// statements must be issued in the correct order inside a $transaction.

test("flag ON + tenant context: exactly 3 SET LOCAL in order (ROLE, business_id, timeout)", async () => {
  const applyFn = requireIsolationFnWithFlag(true);
  const { mockBase, statements } = makeMockBase();

  let queryReceived;
  const fakeArgs = { where: { businessId: "biz_A" } };

  await runWithTenantContext("biz_A", async () => {
    await applyFn(mockBase, fakeArgs, async (a) => { queryReceived = a; return "ok"; });
  });

  assert.equal(statements.length, 3, "flag ON must issue exactly 3 SET LOCAL statements");
  assert.equal(
    statements[0],
    "SET LOCAL ROLE velora_app",
    "first statement must switch CURRENT_USER to velora_app",
  );
  assert.match(
    statements[1],
    /SET LOCAL app\.current_business_id = 'biz_A'/,
    "second statement must set businessId",
  );
  assert.equal(
    statements[2],
    "SET LOCAL statement_timeout = 8000",
    "third statement must cap query execution time",
  );
  assert.equal(mockBase.$transactionCalled, true, "flag ON must open a $transaction");
  assert.deepEqual(queryReceived, fakeArgs, "query must receive the original args unchanged");
});

test("flag ON + no tenant context (cron): pass-through, zero SET LOCAL (cron safety)", async () => {
  // Cron paths (no businessId) must NOT issue SET LOCAL ROLE even with flag ON.
  // Cron runs table-wide deletes as postgres (BYPASSRLS) — switching to velora_app
  // (NOBYPASSRLS) would cause those deletes to silently return 0 rows (D2 gap).
  const applyFn = requireIsolationFnWithFlag(true);
  const { mockBase, statements } = makeMockBase();

  let queryCalled = false;
  await applyFn(mockBase, {}, async () => { queryCalled = true; return []; });

  assert.equal(
    statements.length,
    0,
    "no SET LOCAL of any kind for cron scope, even with RLS flag ON",
  );
  assert.equal(mockBase.$transactionCalled, false, "no $transaction for cron scope");
  assert.ok(queryCalled, "query must still be called");
});

// ── 4. SQL injection protection ───────────────────────────────────────────────

test("extension escapes single quotes in businessId to prevent SQL injection", async () => {
  // A businessId that somehow contains a single quote (shouldn't happen with
  // cuid() but we defend anyway). Use flag ON so the transaction runs.
  const applyFn = requireIsolationFnWithFlag(true);
  const { mockBase, statements } = makeMockBase();

  const maliciousId = "biz'; DROP TABLE \"Product\"; --";

  await runWithTenantContext(maliciousId, async () => {
    await applyFn(mockBase, {}, async () => null);
  });

  // With flag ON: 3 statements — ROLE, business_id (escaped), timeout.
  assert.equal(statements.length, 3);
  const sql = statements[1]; // business_id is the second statement
  // The single quote in the ID must be escaped as double single-quote.
  assert.ok(
    sql.includes("biz''; DROP TABLE"),
    `Expected escaped SQL in statement[1], got: ${sql}`,
  );
  assert.ok(sql.startsWith("SET LOCAL app.current_business_id = '"), "must start with SET LOCAL");
  assert.ok(sql.endsWith("'"), "must end with closing quote");
});

// ── 5. Cross-tenant isolation contract ───────────────────────────────────────

test("business A context cannot see business B rows (simulated RLS enforcement)", async () => {
  // Simulate a DB that enforces RLS: returns rows only if businessId matches
  // the current setting.
  function createMockDb(currentSetting) {
    const rows = [
      { id: "prod_1", businessId: "biz_A", name: "Product A" },
      { id: "prod_2", businessId: "biz_B", name: "Product B" },
    ];
    return {
      findMany: async ({ where }) => {
        // RLS: simulate Postgres filtering rows by current_setting
        return rows.filter(
          (r) =>
            r.businessId === currentSetting &&
            (!where?.businessId || r.businessId === where.businessId),
        );
      },
    };
  }

  // Business A requests products — extension sets context to biz_A.
  let contextForQuery;
  const resultA = await runWithTenantContext("biz_A", async () => {
    contextForQuery = getTenantBusinessId();
    const db = createMockDb(contextForQuery); // RLS uses this setting
    return db.findMany({ where: { businessId: "biz_A" } });
  });

  assert.equal(resultA.length, 1, "Business A should see exactly 1 product");
  assert.equal(resultA[0].businessId, "biz_A");

  // Business B requests products — extension sets context to biz_B.
  const resultB = await runWithTenantContext("biz_B", async () => {
    const ctx = getTenantBusinessId();
    const db = createMockDb(ctx);
    return db.findMany({ where: { businessId: "biz_B" } });
  });

  assert.equal(resultB.length, 1, "Business B should see exactly 1 product");
  assert.equal(resultB[0].businessId, "biz_B");

  // The critical case: Business A context querying for biz_B's data.
  // Even if the app-layer WHERE clause somehow passes biz_B, the RLS filter
  // (using current_setting = biz_A) would return 0 rows.
  const crossTenantAttempt = await runWithTenantContext("biz_A", async () => {
    const ctx = getTenantBusinessId(); // "biz_A"
    const db = createMockDb(ctx); // RLS set to biz_A
    // Attacker bypasses app-layer WHERE and queries for biz_B directly.
    return db.findMany({ where: { businessId: "biz_B" } });
  });

  assert.equal(
    crossTenantAttempt.length,
    0,
    "Cross-tenant read must return 0 rows — RLS blocks it",
  );
});

// ── 6. Nested context (defensive) ────────────────────────────────────────────

test("nested runWithTenantContext uses innermost businessId", async () => {
  let inner;
  await runWithTenantContext("biz_outer", async () => {
    await runWithTenantContext("biz_inner", async () => {
      inner = getTenantBusinessId();
    });
  });
  assert.equal(inner, "biz_inner");
});
