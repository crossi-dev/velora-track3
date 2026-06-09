// First-sale re-engagement nudge — cron-triggered.
//
// Runs every hour (schedule: "0 * * * *"). For each business where the owner
// saw the T4 first-sale prompt but has not yet made a sale within 24 hours,
// injects a warm nudge ChatMessage and marks firstSaleNudgeSent=true to prevent
// repeats. Businesses that already sold after T4 are silently marked as sent too,
// so they never show in future cron scans.
//
// Idempotency: clientMessageId "first-sale-nudge:{businessId}" + the UNIQUE
// constraint on (businessId, clientMessageId) in ChatMessage guarantee exactly-once
// delivery even if the cron fires twice in the same hour.
//
// Protected by CRON_SECRET via verifyCronSecret.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyCronSecret } from "@/app/api/_lib/route-helpers";

export const maxDuration = 60;

const NUDGE_COPY =
  "¿Cuándo te animás a probar tu primera venta? Te la registro al toque, " +
  "decime algo como \"vendí 2 alfajores 1000 efectivo\" y vemos cómo funciona.";

interface NudgeResult {
  nudgesSent: number;
  alreadySold: number;
  errors: string[];
}

// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb
// (Scheduler defaults to POST and we standardised every cron on POST after the
// event-retry 405 incident — see scripts/scheduler-jobs.json).
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "first-sale-nudge");
  if (unauth) return unauth;

  const result: NudgeResult = { nudgesSent: 0, alreadySold: 0, errors: [] };

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Only businesses where T4 was shown ≥24h ago and the nudge hasn't been sent yet.
    const businesses = await prisma.business.findMany({
      where: {
        firstSalePromptShown: true,
        firstSaleNudgeSent: false,
        firstSalePromptShownAt: { lte: cutoff },
      },
      select: {
        id: true,
        firstSalePromptShownAt: true,
      },
    });

    for (const b of businesses) {
      try {
        await processOneBusiness(b.id, b.firstSalePromptShownAt!, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 60) : String(err).slice(0, 60);
        result.errors.push(`${b.id}:${msg}`);
        cloudLog({
          severity: "ERROR",
          component: "System",
          action: "FIRST_SALE_NUDGE_BUSINESS_FAILED",
          a2a_transfer: false,
          message: "first-sale-nudge: unexpected error processing business",
          businessId: b.id,
          data: { error: msg },
        });
      }
    }

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "FIRST_SALE_NUDGE_COMPLETED",
      a2a_transfer: false,
      message: `first-sale-nudge: ${result.nudgesSent} sent, ${result.alreadySold} already-sold, ${result.errors.length} errors`,
      data: result as unknown as Record<string, unknown>,
    });

    return NextResponse.json(result);
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "FIRST_SALE_NUDGE_FAILED",
      a2a_transfer: false,
      message: "first-sale-nudge: cron handler threw an unexpected error",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json(
      { error: "first-sale-nudge failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

async function processOneBusiness(
  businessId: string,
  shownAt: Date,
  result: NudgeResult,
): Promise<void> {
  // Check if a sale exists after T4 was shown — no nudge needed in that case.
  // Sale.date is the sale timestamp (set at creation time, not a createdAt field).
  const recentSale = await prisma.sale.findFirst({
    where: { businessId, date: { gte: shownAt } },
    select: { id: true },
  });

  if (recentSale) {
    // Owner sold after onboarding — mark silently so they never appear in future scans.
    await prisma.business.update({
      where: { id: businessId },
      data: { firstSaleNudgeSent: true },
    });
    result.alreadySold += 1;
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "FIRST_SALE_NUDGE_SKIPPED_SOLD",
      a2a_transfer: false,
      message: "first-sale-nudge: owner already sold — marking sent without nudge",
      businessId,
      data: {},
    });
    return;
  }

  const clientMessageId = `first-sale-nudge:${businessId}`;

  // Atomic: insert nudge + mark sent. If the ChatMessage unique constraint fires
  // (P2002) a concurrent cron already won — treat as idempotent no-op.
  try {
    await prisma.$transaction([
      prisma.chatMessage.create({
        data: {
          businessId,
          clientMessageId,
          kind: "reply",
          source: "manager",
          visibility: "owner_only",
          text: NUDGE_COPY,
        },
      }),
      prisma.business.update({
        where: { id: businessId },
        data: { firstSaleNudgeSent: true },
      }),
    ]);
    result.nudgesSent += 1;
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "FIRST_SALE_NUDGE_SENT",
      a2a_transfer: false,
      message: "first-sale-nudge: nudge message injected into owner chat",
      businessId,
      data: { clientMessageId },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2002") {
      // Duplicate constraint — concurrent cron already wrote this nudge. No-op.
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "FIRST_SALE_NUDGE_DUPLICATE",
        a2a_transfer: false,
        message: "first-sale-nudge: duplicate write — another cron instance already sent this nudge",
        businessId,
        data: {},
      });
      return;
    }
    throw err;
  }
}
