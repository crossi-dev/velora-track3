import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computePlannerNudges, buildPlannerNudgeText } from "../_lib/planner-velocity";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";

export const maxDuration = 30;

/**
 * Daily low-stock reminder + Velora Planner Level 1 nudges.
 * Runs at 12:00 UTC (09:00 ART). Protected by CRON_SECRET bearer token.
 * Single Argentina-wide schedule for now — per-business opening time is not
 * surfaced via a public config endpoint, so dynamic scheduling stays out of
 * scope until a real product reason appears.
 */
// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb.
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "low-stock-alert");
  if (unauth) return unauth;

  // Use Argentina date — UTC date would break idempotency at 21:00 ART (UTC midnight).
  const today = getArgentinaDateString(Date.now());
  const businesses = await prisma.business.findMany({ select: { id: true } });
  if (businesses.length === 0) return NextResponse.json({ ok: true, notified: 0 });

  const bizIds = businesses.map((b) => b.id);

  // Batch idempotency check: one query for all businesses × both message types.
  const lowStockIds = bizIds.map((id) => `low-stock-alert-${id}-${today}`);
  const plannerIds = bizIds.map((id) => `planner-nudge-${id}-${today}`);
  const existingMessages = await prisma.chatMessage.findMany({
    where: { clientMessageId: { in: [...lowStockIds, ...plannerIds] } },
    select: { clientMessageId: true },
  });
  const sent = new Set(existingMessages.map((m) => m.clientMessageId));

  // Only fetch products that are actually below their reorder threshold — avoids
  // loading and grouping all products in memory. reorderThreshold = 0 means
  // "no threshold configured", so we exclude those rows explicitly.
  // Prisma findMany cannot express quantity < reorderThreshold (cross-column), so
  // we use a raw query. ProductRow is declared at module level below.
  // Use Prisma.join() for the array (renders to IN-list). Array casts like
  // ANY(${arr}::text[]) are rejected by Supabase pgbouncer transaction mode (port 6543).
  // Empty bizIds is guarded by the early return above.
  const lowStockProducts: ProductRow[] = await prisma.$queryRaw`
    SELECT "businessId", "name", "reorderThreshold", "quantity"
    FROM "Product"
    WHERE "businessId" IN (${Prisma.join(bizIds)})
      AND "reorderThreshold" > 0
      AND "quantity" < "reorderThreshold"
    ORDER BY "businessId", "quantity" ASC
  `;

  const productsByBiz = new Map<string, ProductRow[]>();
  for (const p of lowStockProducts) {
    const arr = productsByBiz.get(p.businessId) ?? [];
    arr.push(p);
    productsByBiz.set(p.businessId, arr);
  }

  // Collect all write promises so we can await them together and count
  // only the ones that actually succeeded. Fire-and-forget was wrong here:
  // Cloud Scheduler sees 200 and never retries even if every write failed.
  const writePromises: Promise<WriteResult>[] = [];
  for (const biz of businesses) {
    const products = productsByBiz.get(biz.id) ?? [];
    writePromises.push(writeLowStockMessage(biz.id, today, sent, products));
    writePromises.push(writePlannerMessage(biz.id, today, sent));
  }

  const results = await Promise.allSettled(writePromises);
  let notified = 0;
  let errored = 0;
  for (const r of results) {
    if (r.status === "rejected") { errored += 1; continue; }
    if (r.value === "sent") notified += 1;
    else if (r.value === "error") errored += 1;
    // "noop" (already sent / nothing to alert) is a normal quiet outcome
  }

  // 500 only on genuine write failures with zero successes — so Cloud
  // Scheduler retries a real outage but NOT a quiet day with no alerts.
  if (errored > 0 && notified === 0) {
    return NextResponse.json({ ok: false, notified: 0, errored, error: "all writes failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, notified });
}

// Shared row type — matches both the $queryRaw result shape and writeLowStockMessage param.
type ProductRow = {
  businessId: string;
  name: string;
  reorderThreshold: number;
  quantity: number;
};

// "sent" = a message was written; "noop" = nothing to do (already sent or
// no alert needed — a normal quiet outcome); "error" = the write failed.
// handleGet distinguishes these so Cloud Scheduler retries real outages only.
type WriteResult = "sent" | "noop" | "error";

async function writeLowStockMessage(
  businessId: string,
  today: string,
  sent: Set<string>,
  products: ProductRow[],
): Promise<WriteResult> {
  const clientMessageId = `low-stock-alert-${businessId}-${today}`;
  if (sent.has(clientMessageId)) return "noop";

  // products are pre-filtered by the SQL query (quantity < reorderThreshold AND reorderThreshold > 0).
  const lowStock = products.slice(0, 10);

  if (lowStock.length === 0) return "noop";

  const list = lowStock.map((p) => `${p.name} (${p.quantity}u.)`).join(", ");
  const n = lowStock.length;
  const text = `Recordatorio: tenés ${n} producto${n > 1 ? "s" : ""} con poco stock: ${list}.`;
  try {
    await prisma.chatMessage.create({ data: { businessId, clientMessageId, kind: "reply", source: "manager", visibility: "owner_only", text } });
    return "sent";
  } catch (error) {
    cloudLog({ severity: "ERROR", component: "System", action: "LOW_STOCK_ALERT_WRITE_FAILED", a2a_transfer: false, message: "Low-stock alert chat write failed", businessId, data: { error: error instanceof Error ? error.message : String(error) } });
    return "error";
  }
}

async function writePlannerMessage(businessId: string, today: string, sent: Set<string>): Promise<WriteResult> {
  const clientMessageId = `planner-nudge-${businessId}-${today}`;
  if (sent.has(clientMessageId)) return "noop";

  const nudges = await computePlannerNudges(businessId);
  if (nudges.length === 0) return "noop";

  const lines = nudges.map(buildPlannerNudgeText).join("\n");
  const text = `Velora Planner:\n${lines}`;
  try {
    await prisma.chatMessage.create({ data: { businessId, clientMessageId, kind: "reply", source: "manager", visibility: "owner_only", text } });
    return "sent";
  } catch (error) {
    cloudLog({ severity: "ERROR", component: "System", action: "PLANNER_NUDGE_WRITE_FAILED", a2a_transfer: false, message: "Planner nudge chat write failed", businessId, data: { error: error instanceof Error ? error.message : String(error) } });
    return "error";
  }
}
