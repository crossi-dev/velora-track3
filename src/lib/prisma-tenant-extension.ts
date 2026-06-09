// Tenant Isolation Extension for Prisma Client
//
// Implements the DB-layer second door for RLS multi-tenant isolation.
// The first door is the WHERE businessId = ? in every query; this extension
// is the safety net that fires even if the app-layer WHERE clause fails.
//
// Usage: imported by src/lib/prisma.ts — do not import directly in routes.
// Routes set context via runWithTenantContext() from tenant-context.ts.
//
// Pattern: wraps every Prisma operation in an interactive transaction that
// issues SET LOCAL ROLE + SET LOCAL app.current_business_id first, so
// PostgreSQL row-level security policies enforce at the storage engine level.
//
// CRITICAL — Supabase pgbouncer transaction mode:
//   SET LOCAL only holds for the current transaction. When pgbouncer routes
//   each statement to a different backend connection (transaction mode), a
//   bare SET LOCAL without BEGIN/COMMIT is silently lost on the NEXT
//   statement. The $transaction wrapper guarantees BEGIN → SET LOCAL →
//   query → COMMIT in a single pgbouncer slot. Without it, RLS is bypassed
//   on the very next statement after the SET LOCAL.
//
// RLS activation — SET LOCAL ROLE velora_app:
//   The Supabase pooler connects as `postgres` (rolbypassrls=true), which
//   silently bypasses all RLS policies even with FORCE ROW LEVEL SECURITY.
//   PostgreSQL evaluates RLS against CURRENT_USER, not SESSION_USER.
//   `SET LOCAL ROLE velora_app` makes CURRENT_USER = velora_app (NOBYPASSRLS)
//   for the duration of the transaction only. At commit/rollback the LOCAL
//   modifier automatically reverts — no cross-request leakage.
//   DATABASE_URL does NOT change; no session-mode migration required.
//
//   Sources (HTTP 200 verified 2026-06-02):
//     postgresql.org/docs/current/sql-set-role.html    — SET LOCAL ROLE + LOCAL scoping
//     postgresql.org/docs/current/sql-createrole.html  — NOLOGIN vs NOBYPASSRLS semantics
//     postgresql.org/docs/current/ddl-rowsecurity.html — BYPASSRLS always bypasses; CURRENT_USER governs
//
//   Pre-requisite: run prisma/manual/velora_app_role.sql against prod ONCE
//   (creates the velora_app role + grants GRANT velora_app TO postgres).
//
// Feature flag — RLS_SESSION_CONTEXT_ENABLED:
//   Default OFF. When OFF the extension is a TRUE global pass-through: the
//   $allOperations hook returns query(args) immediately without calling
//   getTenantBusinessId(), without opening a $transaction, and without issuing
//   any SET LOCAL statement — byte-identical to origin/main behaviour on every
//   route. This is correct because on origin/main NO production route calls
//   runWithTenantContext (only this PR adds callers), so the extension was
//   always a pass-through before; the flag-OFF path preserves that contract.
//   When ON: wraps every call that has a tenant context in a $transaction that
//   issues, in order: SET LOCAL ROLE velora_app, SET LOCAL app.current_business_id,
//   SET LOCAL statement_timeout = 8000 — then runs the query.
//
// Scope: only applied when getTenantBusinessId() returns a non-empty string.
//   - Cron/scheduled routes have no tenant context → skip entirely → safe
//     because they always filter by businessId in their own WHERE clauses.
//     Cron MUST NOT issue SET LOCAL ROLE (table-wide deletes would return 0
//     rows under NOBYPASSRLS — see D2 known gap in RLS architecture).
//   - Authenticated routes wrap their handlers in runWithTenantContext() →
//     SET LOCAL fires for every Prisma call inside the scope.
//
// Safety: if the extension throws (e.g., $executeRawUnsafe fails), the error
// propagates — we do NOT silently continue. Broken RLS setup must fail loudly.
//
// Architecture: factory function receives the BASE PrismaClient so the
// $transaction call can target it directly. No forward references, no
// module-level mutable state. Closure captures `base` at construction time.

import { Prisma, PrismaClient } from "@prisma/client";
import { getTenantBusinessId } from "@/lib/tenant-context";

// Read once at module load — changing the flag requires a Cloud Run revision
// recycle (by design; this is a server-side security gate, not a per-request
// toggle). Exported for unit tests that need to cover both flag states by
// re-requiring the module with a fresh env value. isRlsActive() re-reads
// the captured constant, so the security-gate behaviour is identical: the
// value is fixed at load time and cannot be toggled mid-process without a
// module cache flush (which only happens in test environments, not prod).
const RLS_ACTIVE = process.env.RLS_SESSION_CONTEXT_ENABLED === "true";
/** @internal exported for unit tests only — do not use in production code */
export const isRlsActive = () => RLS_ACTIVE;

type TxClient = { $executeRawUnsafe: (sql: string) => Promise<unknown> };
type BaseWithTx = { $transaction: (fn: (tx: TxClient) => Promise<unknown>) => Promise<unknown> };

/**
 * Core isolation hook — exported for unit testing against a mock base client.
 * Production code uses this only via buildTenantExtension → Prisma.defineExtension.
 * @internal
 */
export async function applyTenantIsolation(
  base: BaseWithTx,
  args: unknown,
  query: (args: unknown) => Promise<unknown>,
): Promise<unknown> {
  // FIX W-1: flag-OFF is a TRUE global pass-through. This check runs BEFORE
  // getTenantBusinessId() so when the flag is off, no $transaction is opened
  // and no SET LOCAL is issued — even for routes that call runWithTenantContext.
  // This matches origin/main behaviour exactly (on main, no production route
  // calls runWithTenantContext, so the extension was always a pass-through).
  if (!RLS_ACTIVE) return query(args);

  const businessId = getTenantBusinessId();
  if (!businessId) {
    // No tenant context (cron, scheduled, internal) — skip RLS parameter.
    // Cron paths MUST stay as postgres/bypass so table-wide maintenance
    // ops (audit-cleanup deleteMany) are not silently filtered to 0 rows.
    return query(args);
  }
  // Wrap in interactive transaction so SET LOCAL is scoped to the same
  // pgbouncer slot as the actual query (transaction mode requirement).
  //
  // $executeRawUnsafe with manual single-quote escaping:
  //   - businessId comes from AsyncLocalStorage (never from user input)
  //   - We still escape single quotes for defence-in-depth against
  //     hypothetical cuid() corruption or test-environment injection
  //   - $queryRaw tagged templates are avoided because pgbouncer
  //     transaction mode may not support prepared statements for SET
  return base.$transaction(async (tx) => {
    // Switch CURRENT_USER to velora_app (NOBYPASSRLS) for this transaction
    // only. RLS_ACTIVE is always true here (checked above). PostgreSQL
    // evaluates RLS policies against CURRENT_USER, so this activates RLS
    // enforcement even though the session connected as postgres (rolbypassrls).
    // Requires: GRANT velora_app TO postgres (see velora_app_role.sql).
    await tx.$executeRawUnsafe(`SET LOCAL ROLE velora_app`);
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_business_id = '${businessId.replace(/'/g, "''")}'`,
    );
    // REL-N-7: cap query execution time to prevent runaway reads from
    // holding pgbouncer connection slots. Piggybacked on the existing
    // transaction — no additional round-trips added.
    // Belt-and-suspenders: ALTER ROLE velora_app SET statement_timeout
    // in velora_app_role.sql also covers code paths outside this extension.
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 8000`);
    return query(args);
  });
}

export function buildTenantExtension(base: PrismaClient) {
  return Prisma.defineExtension({
    name: "tenant-isolation",
    query: {
      $allOperations({
        args,
        query,
      }: {
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }) {
        return applyTenantIsolation(base, args, query);
      },
    },
  });
}
