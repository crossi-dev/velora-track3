import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { cloudLog } from "@/lib/cloud-logger";
import {
  computeTodaySummary,
  getArgentinaDayBounds,
} from "@/app/dashboard/lib/today-summary";
import {
  type CashMovementRow,
  rowToCashMovement,
  formatDailySummaryMessage,
} from "@/app/api/_lib/daily-summary-content";
import { sendPush } from "@/app/api/_lib/web-push";
import { sendFcmNotification } from "@/lib/firebase-admin";

export interface DailySummaryCronResult {
  processed: number;
  sent: number;
  skipped: number;
  noOps: number;
  errors: number;
  expiredSubscriptions: number;
}

interface BusinessSummaryRow {
  id: string;
  name: string;
  currency: string;
  userId: string | null;
}

interface PushSubscriptionRow {
  id: string;
  userId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  kind: string | null;
  fcmToken: string | null;
}

async function processBusiness(
  business: BusinessSummaryRow,
  bounds: { startMs: number; endMs: number; dateAR: string },
  nowMs: number,
  result: DailySummaryCronResult,
): Promise<void> {
  // Claim the (businessId, dateAR) slot first. Once committed, no other
  // invocation in this 24-hour window can re-enter — UNIQUE constraint
  // on the table guarantees at-most-once delivery.
  let claim: { id: string };
  try {
    claim = await prisma.dailySummaryPushLog.create({
      data: {
        businessId: business.id,
        dateAR: bounds.dateAR,
        status: "pending",
      },
      select: { id: true },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002") {
      result.skipped += 1;
      return;
    }
    throw error;
  }

  result.processed += 1;

  try {
    // Defensive cap: a single-day cash movements page over 10k rows is a tail
    // signal of either malformed data or an outlier tenant — and the downstream
    // computeTodaySummary aggregator doesn't need every row to produce a useful
    // summary. Without this cap, an outlier tenant can OOM the cron worker.
    // Source: debt audit C2.
    const movementRows = (await prisma.cashMovement.findMany({
      where: {
        businessId: business.id,
        date: {
          gte: new Date(bounds.startMs),
          lte: new Date(bounds.endMs),
        },
      },
      select: {
        id: true,
        type: true,
        amount: true,
        date: true,
        description: true,
        saleId: true,
      },
      take: 10000,
      orderBy: { date: "asc" },
    })) as CashMovementRow[];

    const movements = movementRows.map(rowToCashMovement);
    const summary = computeTodaySummary(movements, nowMs);
    const message = formatDailySummaryMessage({
      sales: summary.sales,
      expenses: summary.expenses,
      net: summary.net,
      businessName: business.name,
      currency: business.currency,
    });

    if (!message) {
      await prisma.dailySummaryPushLog.update({
        where: { id: claim.id },
        data: { status: "no-op", sentAt: new Date() },
      });
      result.noOps += 1;
      return;
    }

    // Filter to owner subscriptions only — daily revenue summaries are for
    // the owner, not employees. Business.userId is @unique (single owner).
    // If userId is null (legacy row), fall back to all non-expired subscriptions
    // for that business to avoid silently dropping notifications.
    const subscriptionWhere = business.userId
      ? { businessId: business.id, userId: business.userId, expired: false }
      : { businessId: business.id, expired: false };
    const subscriptions = (await prisma.pushSubscription.findMany({
      where: subscriptionWhere,
      select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true, kind: true, fcmToken: true },
    })) as PushSubscriptionRow[];

    if (subscriptions.length === 0) {
      await prisma.dailySummaryPushLog.update({
        where: { id: claim.id },
        data: {
          status: "no-op",
          sentAt: new Date(),
          error: "no-active-subscriptions",
        },
      });
      result.noOps += 1;
      return;
    }

    let anyOk = false;
    let lastError: string | null = null;

    const pushPayload = { ...message, notificationCategory: "daily_summary" as const, entityId: bounds.dateAR };

    for (const sub of subscriptions) {
      // DUAL-CHANNEL: route FCM (Capacitor Android) rows through firebase-admin
      // instead of web-push. FCM tokens are not HTTPS URLs — feeding them to
      // webpush.sendNotification() would fire a network request to a non-existent
      // host and never produce a 404/410 to mark the row expired.
      if (sub.kind === "fcm") {
        if (!sub.fcmToken) continue; // Malformed row — skip silently.
        const fcmResult = await sendFcmNotification(
          sub.fcmToken,
          pushPayload.title,
          pushPayload.body,
          { url: pushPayload.url, notificationCategory: pushPayload.notificationCategory, entityId: pushPayload.entityId },
        );
        if (fcmResult.ok) {
          anyOk = true;
        } else if (fcmResult.reason === "invalid-token") {
          await prisma.pushSubscription.update({ where: { id: sub.id }, data: { expired: true } });
          result.expiredSubscriptions += 1;
        } else if (fcmResult.reason !== "firebase-not-configured") {
          lastError = `fcm:${fcmResult.reason}`;
        }
        continue;
      }

      // Web Push (kind = "webpush" or legacy rows without kind).
      const sendResult = await sendPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        pushPayload,
      );
      if (sendResult.ok) {
        anyOk = true;
      } else if (sendResult.expired) {
        await prisma.pushSubscription.update({
          where: { id: sub.id },
          data: { expired: true },
        });
        result.expiredSubscriptions += 1;
      } else {
        lastError = sendResult.error ?? `status=${sendResult.statusCode}`;
      }
    }

    if (anyOk) {
      await prisma.dailySummaryPushLog.update({
        where: { id: claim.id },
        data: { status: "sent", sentAt: new Date() },
      });
      result.sent += 1;

      await recordCriticalWriteEvent({
        client: prisma,
        businessId: business.id,
        actorUserId: "system:cron",
        routeScope: "cron/daily-summary-push",
        actionType: "daily-summary.push.send",
        resourceType: "business",
        resourceId: business.id,
        summary: `Resumen del día enviado (${bounds.dateAR})`,
        payload: {
          dateAR: bounds.dateAR,
          sales: summary.sales,
          expenses: summary.expenses,
          net: summary.net,
          subscriptionsTried: subscriptions.length,
        },
      });
    } else {
      await prisma.dailySummaryPushLog.update({
        where: { id: claim.id },
        data: { status: "failed", sentAt: new Date(), error: lastError ?? "no-success" },
      });
      result.errors += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cloudLog({ severity: "ERROR", component: "System", action: "DAILY_SUMMARY_PROCESS_FAILED", a2a_transfer: false, message: "Daily summary processing failed for business", businessId: business.id, data: { error: message } });
    await prisma.dailySummaryPushLog.update({
      where: { id: claim.id },
      data: { status: "failed", error: message.slice(0, 500) },
    });
    result.errors += 1;
  }
}

export async function runDailySummaryCron(nowMs: number = Date.now()): Promise<DailySummaryCronResult> {
  const bounds = getArgentinaDayBounds(nowMs);
  const result: DailySummaryCronResult = {
    processed: 0,
    sent: 0,
    skipped: 0,
    noOps: 0,
    errors: 0,
    expiredSubscriptions: 0,
  };

  // Businesses with at least one cash movement in today's AR window. We pull
  // them via groupBy to skip the long tail of inactive businesses without
  // loading every movement.
  const groups = await prisma.cashMovement.groupBy({
    by: ["businessId"],
    where: {
      date: {
        gte: new Date(bounds.startMs),
        lte: new Date(bounds.endMs),
      },
    },
  });

  if (groups.length === 0) return result;

  const businessRows = await prisma.business.findMany({
    where: { id: { in: groups.map((g) => g.businessId) } },
    select: { id: true, name: true, currency: true, userId: true },
  });
  const businesses = businessRows as BusinessSummaryRow[];

  for (const business of businesses) {
    try {
      await processBusiness(business, bounds, nowMs, result);
    } catch (error) {
      // Per-business isolation: one failing business must not block the rest.
      result.errors += 1;
      cloudLog({ severity: "ERROR", component: "System", action: "DAILY_SUMMARY_CRON_BUSINESS_FAILED", a2a_transfer: false, message: "Daily summary cron failed for business", businessId: business.id, data: { error: error instanceof Error ? error.message : String(error) } });
    }
  }

  return result;
}
