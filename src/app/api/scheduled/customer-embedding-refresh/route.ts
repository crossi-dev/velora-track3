import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { embedText, isEmbeddingsEnabled } from "@/lib/embeddings";
import {
  buildCustomerEmbedText,
  persistCustomerEmbedding,
} from "@/lib/semantic-recall";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyCronSecret } from "@/app/api/_lib/route-helpers";

export const maxDuration = 300;

/**
 * Customer embedding refresh cron — daily at 04:30 UTC.
 *
 * Refreshes pgvector embeddings for customers where:
 *   - embedding IS NULL (new customer or backfill)
 *   - OR embeddingUpdatedAt < updatedAt (stale)
 *
 * Bounded at 500 rows per run to keep maxDuration safe. The cron just runs
 * again tomorrow if a tenant has more changes.
 *
 * No-op if USE_EMBEDDINGS != "true".
 */
// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb.
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "customer-embedding-refresh");
  if (unauth) return unauth;

  if (!isEmbeddingsEnabled()) {
    return NextResponse.json({ skipped: true, reason: "USE_EMBEDDINGS disabled" });
  }

  // Find candidates needing (re)embedding. Use raw query because we need to
  // express the staleness predicate involving the vector column nullability.
  // Selects businessId so the persist call can scope its UPDATE by tenant.
  //
  // RLS-verify audit (Group D): this cross-tenant $queryRaw is INTENTIONAL.
  // This is a privileged cron sweeper that processes ALL tenants in a single pass,
  // mirroring the audit-cleanup pattern (post-commit-replay.ts, AuditCleanup cron).
  // The SELECT spans all tenants by design — per-row UPDATE at persist time is
  // tenant-scoped via businessId. This is acceptable because:
  //   1. Route is auth-gated (verifyCronSecret — CRON_SECRET, no user-level actor).
  //   2. Data read is non-sensitive (names, emails, phones — used only for embedding,
  //      never returned to any user).
  //   3. Consistent with CLAUDE.md known-gaps §Cron + RLS architectural gap (D2).
  // Long-term fix: add FOR SELECT USING (true) policy or velora_maintenance role when
  // RLS is enforced via NOBYPASSRLS velora_app role.
  const candidates = await prisma.$queryRaw<Array<{
    id: string; businessId: string; name: string; email: string | null; phone: string | null;
  }>>`
    SELECT id, "businessId", name, email, phone
    FROM "Customer"
    WHERE embedding IS NULL
       OR ("embeddingUpdatedAt" IS NOT NULL AND "embeddingUpdatedAt" < "updatedAt")
    ORDER BY "updatedAt" DESC
    LIMIT 500
  `;

  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ customerId: string; reason: string }> = [];

  // Process in mini-batches with bounded concurrency. Each row needs ONE Vertex
  // embedding HTTP call + ONE DB persist. Sequential was N × ~500ms ≈ 4 min for
  // 500 candidates. CONCURRENCY=10 brings the wall-clock down ~10x while keeping
  // Vertex rate-limit friendly. Source: debt audit C1.
  const CONCURRENCY = 10;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(async (c) => {
      const text = buildCustomerEmbedText(c);
      const embedded = await embedText(text);
      if (!embedded) return { ok: false, reason: "embed_failed" as const, customerId: c.id };
      const ok = await persistCustomerEmbedding({
        businessId: c.businessId,
        customerId: c.id,
        embedding: embedded.vector,
      });
      return ok
        ? { ok: true as const, customerId: c.id }
        : { ok: false, reason: "persist_failed" as const, customerId: c.id };
    }));
    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.ok) {
          succeeded++;
        } else {
          failed++;
          failures.push({ customerId: r.value.customerId, reason: r.value.reason });
        }
      } else {
        failed++;
        failures.push({ customerId: "?", reason: r.reason instanceof Error ? r.reason.message : "unexpected_throw" });
      }
    }
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "CUSTOMER_EMBEDDING_REFRESH",
    a2a_transfer: false,
    message: "Customer embedding refresh completed",
    data: {
      candidatesFound: candidates.length,
      succeeded,
      failed,
      failureSampleSize: Math.min(failures.length, 5),
    },
  });

  return NextResponse.json({
    candidatesFound: candidates.length,
    succeeded,
    failed,
    failures: failures.slice(0, 5),
  });
}
