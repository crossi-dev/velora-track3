// Free-tier daily chat quota per business for the owner's /api/business-assistant
// hits. Default cap: FREE_DAILY_CHAT_LIMIT (env, fallback 50). Testers in
// TESTER_EMAILS (env, comma-separated) bypass the counter entirely so internal
// development and demos never trigger the cap.
//
// Usage: call checkAndIncrementOwnerChatQuota({ businessId, ownerEmail }) once
// per /api/business-assistant request BEFORE invoking the supervisor. If the
// result is { allowed: false, ... }, short-circuit with the quota-exhausted
// response. If allowed, proceed normally.
//
// Counter is keyed by businessId + ART date string ("YYYY-MM-DD"). Reset is
// implicit when a new date string appears. The upsert+increment is atomic via
// Prisma upsert with `update.count.increment`.

import { prisma } from "@/lib/prisma";
import { reportWarning } from "@/lib/cloud-logger";
import { isTesterEmail } from "@/lib/tester-allowlist";
import { getArgentinaDateString } from "@/lib/argentina-date";
import { isDemoBusiness } from "@/lib/demo-business";

const DEFAULT_LIMIT = 50;

function getDailyLimit(): number {
  const raw = process.env.FREE_DAILY_CHAT_LIMIT;
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

export { isTesterEmail };

export interface QuotaResult {
  allowed: boolean;
  remaining: number; // -1 if tester (no limit), otherwise (limit - newCount)
  limit: number;
  current: number;
  exempt: boolean;
}

export async function checkAndIncrementOwnerChatQuota(args: {
  businessId: string;
  // True when the caller already verified the actor is a tester via
  // resolveActor()'s `isTester` field. Bypasses the counter increment.
  isTester: boolean;
}): Promise<QuotaResult> {
  const limit = getDailyLimit();

  if (args.isTester || isDemoBusiness(args.businessId)) {
    return { allowed: true, remaining: -1, limit, current: 0, exempt: true };
  }

  const date = getArgentinaDateString();

  try {
    const row = await prisma.ownerChatUsage.upsert({
      where: { businessId_date: { businessId: args.businessId, date } },
      create: { businessId: args.businessId, date, count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    });
    return {
      allowed: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      limit,
      current: row.count,
      exempt: false,
    };
  } catch (err) {
    // DB error → fail OPEN (allow the request). Logged so we notice in metrics
    // but never block real owners because of a transient DB hiccup.
    reportWarning("owner-chat-quota: upsert failed — failing open", {
      businessId: args.businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, remaining: -1, limit, current: 0, exempt: false };
  }
}

export function buildQuotaExhaustedResponse(remaining: number, limit: number) {
  return {
    answer: `Llegaste al tope de ${limit} mensajes diarios del plan free. Se renueva mañana. Si querés seguir usando Velora sin límite, suscribite al plan Pro.`,
    actions: [],
    chips: {
      kind: "single" as const,
      options: [
        { label: "Suscribirme a Pro", value: "subscribe_pro" },
        { label: "Esperar a mañana", value: "wait_tomorrow" },
      ],
    },
    quota: { remaining, limit, exhausted: true },
  };
}
