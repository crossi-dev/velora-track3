import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyCronSecret } from "@/app/api/_lib/route-helpers";
import {
  computeTodaySummary,
  getArgentinaDayBounds,
} from "@/app/dashboard/lib/today-summary";
import {
  type CashMovementRow,
  rowToCashMovement,
  formatMoney,
} from "@/app/api/_lib/daily-summary-content";

export const maxDuration = 30;

/**
 * Daily summary as a chat message (Flujo 2 — modo chat).
 * Runs at 23:00 UTC (20:00 AR). Protected by CRON_SECRET.
 *
 * Writes one ChatMessage per business that had ≥1 sale today (AR calendar
 * day). The message is dedup'd via ChatMessage's UNIQUE(businessId,
 * clientMessageId) — running the cron twice in the same AR day is a no-op.
 *
 * If there were no sales (only gastos, or no movements at all) → skip.
 * Replaces the deactivated push variant — same content, same window, but
 * lives in the chat thread instead of as an OS notification.
 */
// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb.
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "daily-summary-chat");
  if (unauth) return unauth;

  const nowMs = Date.now();
  const bounds = getArgentinaDayBounds(nowMs);

  const groups = await prisma.cashMovement.groupBy({
    by: ["businessId"],
    where: {
      date: {
        gte: new Date(bounds.startMs),
        lte: new Date(bounds.endMs),
      },
    },
  });

  let written = 0;
  let skipped = 0;
  let errors = 0;

  for (const { businessId } of groups) {
    try {
      const result = await writeSummaryMessage(businessId, bounds, nowMs);
      if (result === "written") written += 1;
      else skipped += 1;
    } catch (error) {
      errors += 1;
      cloudLog({ severity: "ERROR", component: "System", action: "DAILY_SUMMARY_CHAT_FAILED", a2a_transfer: false, message: "Daily summary chat write failed for business", businessId, data: { error: error instanceof Error ? error.message : String(error) } });
    }
  }

  return NextResponse.json({ ok: true, written, skipped, errors, dateAR: bounds.dateAR });
}

function buildSummaryText(
  summary: { sales: number; expenses: number; net: number },
  currency: string,
): string {
  const sales = formatMoney(summary.sales, currency);
  if (summary.expenses <= 0) {
    return `Resumen de hoy — vendiste ${sales}, te quedó ${sales}.`;
  }
  const expenses = formatMoney(summary.expenses, currency);
  const netSign = summary.net < 0 ? "-" : "";
  const net = formatMoney(summary.net, currency);
  return `Resumen de hoy — vendiste ${sales}, gastaste ${expenses}, te quedó ${netSign}${net}.`;
}

async function writeSummaryMessage(
  businessId: string,
  bounds: { startMs: number; endMs: number; dateAR: string },
  nowMs: number,
): Promise<"written" | "skipped"> {
  // clientMessageId is stable per (businessId, AR-date): Cloud Scheduler
  // at-least-once delivery means this function may run twice in the same window.
  // Using upsert (update: {}) as the write pattern collapses duplicates at the
  // DB unique constraint instead of a two-step find+create (race window).
  // Ref: Cloud Scheduler at-least-once delivery — https://cloud.google.com/scheduler/docs/at-least-once
  const clientMessageId = `daily-summary-${businessId}-${bounds.dateAR}`;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { currency: true },
  });
  if (!business) return "skipped";

  const movementRows = (await prisma.cashMovement.findMany({
    where: {
      businessId,
      date: {
        gte: new Date(bounds.startMs),
        lte: new Date(bounds.endMs),
      },
    },
    take: 10000, // defensive cap — matches the daily-summary-push variant
    select: {
      id: true,
      type: true,
      amount: true,
      date: true,
      description: true,
      saleId: true,
    },
  })) as CashMovementRow[];

  const summary = computeTodaySummary(movementRows.map(rowToCashMovement), nowMs);
  // Bible §4 — regla "día malo = silencio" (revisada): el supervisor sólo
  // calla en días con cero ventas. Cuando hay ventas pero el resultado es
  // negativo (gastos > ingresos), escribe un mensaje de alerta en lugar de
  // silenciar al owner — el silencio se interpretaría como bug.
  if (summary.sales <= 0) return "skipped";
  if (summary.net < 0) {
    await prisma.chatMessage.upsert({
      where: { businessId_clientMessageId: { businessId, clientMessageId } },
      update: {},
      create: {
        businessId,
        clientMessageId,
        kind: "reply",
        source: "manager",
        visibility: "owner_only",
        text: `Hoy cerraste con resultado negativo: $${Math.abs(summary.net).toLocaleString("es-AR")}. Revisemos juntos qué pasó.`,
      },
    });
    return "written";
  }

  const lowStockMsgs = await prisma.chatMessage.findMany({
    where: { businessId, clientMessageId: { startsWith: "planner-threshold-" }, createdAt: { gte: new Date(bounds.startMs) } },
    select: { text: true },
    take: 5,
  });
  const lowStockProducts = lowStockMsgs
    .map((m) => m.text.split(" cruzó")[0].trim())
    .filter(Boolean);

  let text = buildSummaryText(summary, business.currency);
  if (lowStockProducts.length > 0) {
    text += `\n⚠️ Stock bajo hoy: ${lowStockProducts.join(", ")}.`;
  }

  await prisma.chatMessage.upsert({
    where: { businessId_clientMessageId: { businessId, clientMessageId } },
    update: {},
    create: {
      businessId,
      clientMessageId,
      kind: "reply",
      source: "manager",
      visibility: "owner_only",
      text,
    },
  });
  return "written";
}
