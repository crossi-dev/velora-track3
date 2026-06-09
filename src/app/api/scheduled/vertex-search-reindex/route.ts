import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { indexProducts, isVertexSearchEnabled } from "@/lib/vertex-search";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyCronSecret } from "@/app/api/_lib/route-helpers";

export const maxDuration = 300;

/**
 * Vertex AI Search reindex cron — daily at 03:00 UTC.
 *
 * Pushes every business's product catalog into its per-tenant Vertex AI
 * Search datastore. Incremental reconciliation — only changed/new docs are
 * persisted; deletions handled by separate full-rebuild path (manual).
 *
 * The datastore per business is created on-demand when the first product
 * is registered. See docs/VERTEX_SEARCH_SETUP.md.
 *
 * No-op if USE_VERTEX_SEARCH != "true" — the cron still runs but returns
 * { skipped: true } without touching Vertex.
 */
// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb.
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "vertex-search-reindex");
  if (unauth) return unauth;

  if (!isVertexSearchEnabled()) {
    return NextResponse.json({ skipped: true, reason: "USE_VERTEX_SEARCH disabled" });
  }

  const businesses = await prisma.business.findMany({ select: { id: true } });
  const summary = {
    businesses: businesses.length,
    indexed: 0,
    failed: 0,
    errors: [] as Array<{ businessId: string; error: string }>,
  };

  // Mini-batch fan-out: each business needs a DB findMany + a Vertex Search
  // HTTP indexProducts call. Sequential was N × (DB_RTT + Vertex_RTT). With
  // CONCURRENCY=5, wall-clock drops ~5x while staying gentle on Vertex API quota.
  // Source: debt audit C1.
  const CONCURRENCY = 5;
  for (let i = 0; i < businesses.length; i += CONCURRENCY) {
    const chunk = businesses.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(async (biz) => {
      const products = await prisma.product.findMany({
        where: { businessId: biz.id },
        select: { id: true, name: true, sku: true },
      });
      if (products.length === 0) return { biz, skipped: true as const };
      const result = await indexProducts({
        businessId: biz.id,
        products: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
      });
      return { biz, skipped: false as const, result };
    }));

    for (const r of results) {
      if (r.status === "rejected") {
        summary.failed += 1;
        summary.errors.push({ businessId: "?", error: r.reason instanceof Error ? r.reason.message : "unexpected_throw" });
        continue;
      }
      const { biz, skipped } = r.value;
      if (skipped) continue;
      const { result } = r.value;
      if (result.ok) {
        summary.indexed += result.indexed;
      } else {
        summary.failed += 1;
        summary.errors.push({ businessId: biz.id, error: result.error ?? "unknown" });
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "VERTEX_SEARCH_REINDEX_FAILED",
          a2a_transfer: false,
          message: `Vertex AI Search reindex failed for business`,
          businessId: biz.id,
          data: { error: result.error },
        });
      }
    }
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "VERTEX_SEARCH_REINDEX_RUN",
    a2a_transfer: false,
    message: `Vertex AI Search reindex completed`,
    data: {
      businessesProcessed: summary.businesses,
      productsIndexed: summary.indexed,
      failures: summary.failed,
    },
  });

  return NextResponse.json(summary);
}
