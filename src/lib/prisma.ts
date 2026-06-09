import { PrismaClient } from "@prisma/client";
import { validateEnv } from "@/lib/env";
import { buildTenantExtension } from "@/lib/prisma-tenant-extension";

validateEnv();

// Enforce sslmode=require on every connection regardless of how DATABASE_URL is set.
// Neon already enforces TLS, but this makes compliance explicit and portable.
function withSsl(url: string): string {
  if (!url || url.includes("sslmode=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}sslmode=require`;
}

// NOTE: We previously appended `options=-c statement_timeout=10000` here, but
// Neon's pooled connection (PgBouncer in transaction mode) rejects libpq startup
// parameters not on its allowlist — caused PrismaClientInitializationError in
// production. Set statement_timeout via session-level Prisma middleware if we
// want it back; do NOT re-add it to the URL.

function makePrisma() {
  const base = new PrismaClient({
    datasources: { db: { url: withSsl(process.env.DATABASE_URL ?? "") } },
  });
  // Apply RLS tenant isolation extension. Every query inside a
  // runWithTenantContext() scope will SET LOCAL app.current_business_id
  // before executing, giving PostgreSQL RLS policies their enforcement hook.
  // See src/lib/prisma-tenant-extension.ts for full design rationale.
  return base.$extends(buildTenantExtension(base));
}

/**
 * Connection pooling notes (Neon + Cloud Run):
 *
 * - Neon Postgres exposes two URLs per branch: a DIRECT connection and a POOLED
 *   connection (pgbouncer-style, transaction mode). DATABASE_URL in production
 *   MUST point at the pooled URL — serverless functions spin up short-lived
 *   instances and a direct URL exhausts Postgres max_connections under spike.
 * - Migrations run against the DIRECT url (DIRECT_URL env) because pgbouncer's
 *   transaction mode doesn't support prepared statements / advisory locks that
 *   `prisma migrate` needs. See prisma/schema.prisma `datasource.directUrl`.
 * - For hotter traffic (>~1 req/s sustained across many instances), the Neon
 *   pooler's connection ceiling becomes the bottleneck. Mitigation path:
 *   upgrade to Prisma Accelerate (edge-cached, global pool) or move DATABASE_URL
 *   to a pgbouncer pool sized to the Neon compute tier.
 * - The globalForPrisma singleton below prevents dev-mode hot-reload from
 *   creating a new PrismaClient per edit (which each hold their own pool).
 * - RLS tenant extension: every query inside a runWithTenantContext() scope
 *   automatically issues SET LOCAL app.current_business_id before executing.
 *   See src/lib/prisma-tenant-extension.ts for the full design rationale.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof makePrisma>;
};
export const prisma = globalForPrisma.prisma ?? makePrisma();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
