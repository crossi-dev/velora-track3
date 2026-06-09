// Tenant context — propagates the current businessId across async boundaries
// within a single request without threading it through every function call.
//
// Usage:
//   import { runWithTenantContext, getTenantBusinessId } from "@/lib/tenant-context";
//
//   // In route handler, after resolveActor():
//   return runWithTenantContext(actor.businessId, async () => {
//     // All Prisma calls inside here will have SET LOCAL app.current_business_id
//     // applied automatically by the tenantExtension in src/lib/prisma.ts.
//   });
//
// Design notes:
//   - Separate from TraceStore (cloud-logger.ts) — single responsibility.
//   - Returns undefined when called outside a runWithTenantContext scope
//     (cron jobs, scheduled routes, internal calls that don't have a tenant).
//     The extension skips SET LOCAL when businessId is absent — safe because
//     cron/scheduled routes always filter by businessId in their own WHERE clauses.
//   - Cloud Run: each request is its own async scope; AsyncLocalStorage does NOT
//     leak across requests. This is the standard Node.js request-isolation pattern.

import { AsyncLocalStorage } from "node:async_hooks";

interface TenantStore {
  businessId: string;
}

const tenantStorage = new AsyncLocalStorage<TenantStore>();

/**
 * Run `fn` with the given businessId bound as the current tenant.
 * All Prisma calls within `fn` (and any async functions it awaits) will
 * automatically receive SET LOCAL app.current_business_id = businessId.
 */
export function runWithTenantContext<T>(businessId: string, fn: () => T): T {
  return tenantStorage.run({ businessId }, fn);
}

/**
 * Returns the businessId of the current tenant context, or undefined
 * if called outside a runWithTenantContext scope.
 */
export function getTenantBusinessId(): string | undefined {
  return tenantStorage.getStore()?.businessId;
}
