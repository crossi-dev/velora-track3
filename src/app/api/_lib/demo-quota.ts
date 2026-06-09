/**
 * demo-quota.ts — Per-business demo action quota.
 *
 * Every business starts in demoMode=true with a limited number of
 * state-changing actions (sales, stock-loads, cash-movements). When
 * the limit is reached, the next action is refused with a structured
 * DEMO_LIMIT_REACHED error. Flip demoMode=false to unlock unlimited
 * actions for paying clients.
 *
 * Kill-switch: DEMO_QUOTA_ENABLED must be exactly "true" for any quota
 * logic to run. When unset or any other value, this module is fully
 * inert — no DB reads, no increments, no behavior change at all.
 * Mirror of the RATE_LIMIT_ENABLED pattern (process.env.X === "true").
 */

import { prisma } from "@/lib/prisma";
import type { Tx } from "@/domain/ports/tx";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

// ── Kill-switch ───────────────────────────────────────────────────────────────

export function isDemoQuotaEnabled(): boolean {
  return process.env.DEMO_QUOTA_ENABLED === "true";
}

// ── Typed error ───────────────────────────────────────────────────────────────

export class DemoLimitReachedError extends Error {
  readonly code = "DEMO_LIMIT_REACHED" as const;
  constructor(message: string) {
    super(message);
    this.name = "DemoLimitReachedError";
  }
}

const DEMO_LIMIT_MESSAGE =
  "Llegaste al límite de acciones de la demo de Velora. " +
  "Convertite en cliente para seguir operando sin límites.";

// ── Pre-action guard ──────────────────────────────────────────────────────────

/**
 * assertDemoQuota — call BEFORE beginning an idempotent mutation.
 *
 * If quota is disabled → returns immediately (no DB hit).
 * If demoMode=true and demoActionsUsed >= demoActionsLimit → throws
 *   DemoLimitReachedError so the caller can surface it as a structured
 *   403 without executing any write.
 * If demoMode=false or quota not reached → returns normally.
 */
export async function assertDemoQuota(businessId: string): Promise<void> {
  if (!isDemoQuotaEnabled()) return;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { demoMode: true, demoActionsUsed: true, demoActionsLimit: true },
  });

  if (!business) return; // let the caller handle missing business

  if (business.demoMode && business.demoActionsUsed >= business.demoActionsLimit) {
    throw new DemoLimitReachedError(DEMO_LIMIT_MESSAGE);
  }
}

// ── In-transaction increment ──────────────────────────────────────────────────

/**
 * incrementDemoActionInTx — call INSIDE an existing Prisma transaction,
 * after the main writes succeed, to atomically bump the used counter.
 *
 * If quota is disabled → no-op (returns immediately without touching the DB).
 * Safe to call even when demoMode=false — the guard already passed so the
 * increment just accumulates a counter that is never checked for non-demo
 * businesses. That avoids an extra branch here and keeps the call-site clean.
 */
export async function incrementDemoActionInTx(
  tx: Tx,
  businessId: string,
): Promise<void> {
  if (!isDemoQuotaEnabled()) return;

  const prismaTx = toPrismaTx(tx);
  await prismaTx.business.update({
    where: { id: businessId },
    data: { demoActionsUsed: { increment: 1 } },
  });
}
