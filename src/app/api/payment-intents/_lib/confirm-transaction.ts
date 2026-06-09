// Atomic confirm batch for PaymentIntent — extracted from payment-intent-use-case.ts
// to stay under the 300-line hard limit. Observability helpers live in the sibling
// confirm-transaction-observability.ts (items 1–5 of 2026 hardening spec).
//
// pgbouncer compatibility: sequential batch form `prisma.$transaction([...])` only.
// Reads happen OUTSIDE the transaction; no await yields inside BEGIN...COMMIT.
// Sources: prisma.io/docs/orm/prisma-client/queries/transactions
//          supabase.com/docs/guides/database/prisma#prisma-with-supabase-connection-pooling

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import type { PaymentMethodValue } from "@/domain/sale";
import {
  classifyBatchError,
  logDedupHit,
  auditBatchFailure,
  logPiRaceLost,
  logSaleRaceLost,
} from "./confirm-transaction-observability";

// All PaymentIntent metodo values originate from the MP/QR payment surface.
// Map them to the canonical PaymentMethodValue for CashMovement.paymentMethod
// so the cash-register breakdown (WS2) correctly attributes MP-paid sales.
//
// OBSERVABILITY GUARD (item 5): unexpected metodo values signal schema drift or
// data corruption. Per Stripe canonical observability, unknown payment method
// values must NEVER be silently coerced. Ref: stripe.com/docs/api/payment_methods/object
function intentMetodoToPaymentMethod(metodo: string): PaymentMethodValue {
  // Known metodo variants: "qr_dynamic_fake", "qr_dynamic_real",
  // "checkout_pro_link", "alias_personal" — all QR/MP channels → "qr".
  // If a new metodo is added that maps differently, extend this set first.
  const KNOWN_METODO_VALUES = new Set([
    "qr_dynamic_fake",
    "qr_dynamic_real",
    "checkout_pro_link",
    "alias_personal",
  ]);
  if (!KNOWN_METODO_VALUES.has(metodo)) {
    cloudLog({
      severity: "WARNING",
      message: "MP_CONFIRM_UNKNOWN_METODO",
      component: "Payments",
      action: "MP_CONFIRM_UNKNOWN_METODO",
      a2a_transfer: false,
      data: { metodo, fallback: "qr" },
    });
  }
  return "qr";
}

export interface ConfirmTxInput {
  businessId: string;
  actorEmployeeId: string | null;
  paymentIntentId: string;
  // Set to true when the confirmation originates from a provider webhook
  // (actorUserId in WEBHOOK_ACTOR_IDS: "system-mp-webhook", "system-modo-webhook").
  // Upgrades a QR placeholder `metodo` to "qr_dynamic_real" so the audit trail
  // reflects the real payment — PCI-DSS 4.0 Req 10.2.1. EXCEPTION: a
  // "checkout_pro_link" intent keeps its metodo — it was already a real link
  // payment, and post-confirm routing (payment-intent-post-confirm.ts)
  // discriminates camino A/B by that value.
  isWebhookConfirm?: boolean;
}

export type ConfirmTxResult =
  | { outcome: "confirmed"; paymentIntentId: string; saleId: string | null }
  | { outcome: "not_found" }
  | { outcome: "already_confirmed" }
  | { outcome: "expired"; paymentIntentId: string };

export async function runConfirmTransaction(
  input: ConfirmTxInput,
): Promise<ConfirmTxResult> {
  // ── Phase 1: Read outside the transaction ──────────────────────────────────
  // pgbouncer transaction mode: reads must happen before the batch transaction
  // so no await yields occur inside the BEGIN...COMMIT window.
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: input.paymentIntentId, businessId: input.businessId },
    select: {
      id: true,
      saleId: true,
      monto: true,
      estado: true,
      expiresAt: true,
      metodo: true,
    },
  });

  if (!intent) return { outcome: "not_found" };
  if (intent.estado === "confirmed") return { outcome: "already_confirmed" };

  const now = new Date();

  // ── Phase 2: Early-exit reads + state decisions ────────────────────────────

  // C-2 FIX: when the confirm originates from a provider webhook (isWebhookConfirm=true),
  // do NOT reject an already-expired intent. MP webhooks can arrive minutes or hours
  // after the intent was created (MP retry window up to 72h). A late webhook means the
  // buyer DID pay — we must honour it by reopening the intent to "pending" so the
  // confirm proceeds. Without this, a confirmed MP payment is silently lost because
  // the in-store 2-min expiry fired before the webhook arrived.
  const shouldReopen =
    input.isWebhookConfirm === true && intent.estado === "expired";

  if (!input.isWebhookConfirm && intent.estado === "expired") {
    return { outcome: "expired", paymentIntentId: intent.id };
  }

  if (!input.isWebhookConfirm && intent.expiresAt && now > intent.expiresAt) {
    // Lazy expiry: intent was still "pending" but expiresAt passed.
    // Write the expired state as a single-op batch (no other writes needed).
    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { estado: "expired" },
      }),
    ]);
    return { outcome: "expired", paymentIntentId: intent.id };
  }

  // Webhook confirm upgrades a QR placeholder to "qr_dynamic_real", but a
  // "checkout_pro_link" intent must keep its metodo — post-confirm routes
  // the comprobante + Andreani shipment + owner notice off that value.
  const effectiveMetodo =
    input.isWebhookConfirm && intent.metodo !== "checkout_pro_link"
      ? "qr_dynamic_real"
      : intent.metodo;

  // Deterministic client message id shared by both branches so the DB-level
  // partial unique index "CashMovement_businessId_clientMessageId_key"
  // (migration 20260525900000) can enforce dedup regardless of which branch
  // is taken. Pattern: every monetary write carries a stable, deterministic
  // key — the DB constraint is the final backstop against concurrent retries.
  // Reference: brandur.org/idempotency-keys (Stripe-like DB-level dedup),
  // PostgreSQL partial unique index docs (postgresql.org/docs/current/indexes-partial.html).
  const cashClientMessageId = `mp-confirm-${intent.id}`;

  // Pre-fetch sale state (read outside transaction — pgbouncer requirement).
  // Tenant-scope guard: use businessId filter so a cross-tenant saleId stored
  // on the intent (defensive) cannot update another tenant's sale.
  let saleShouldUpdate = false;
  if (intent.saleId) {
    const sale = await prisma.sale.findFirst({
      where: { id: intent.saleId, businessId: input.businessId },
      select: { id: true, status: true },
    });
    saleShouldUpdate = sale !== null && sale.status !== "paid";
  }

  // ── Phase 3: Atomic batch ($transaction array form) ───────────────────────
  // SLICE 3 FIX (2026-06-07): Supersedes the 2026-05-26 sequential workaround.
  // History: PI pi_example_002 — P2002 on CashMovement rolled back
  // the batch → PI stuck "pending" forever. Workaround: sequential writes.
  // Gap (audit C-1): process death between 3a and 3c left PI confirmed with
  // no CashMovement — permanently missing, invisible to reconcile.
  //
  // Fix closes BOTH failure modes atomically:
  //   A (original): createMany(skipDuplicates:true) → INSERT ... ON CONFLICT DO NOTHING
  //      (Ref: postgresql.org/docs/current/sql-insert.html). Duplicate silently skipped;
  //      no P2002 raised; batch always commits. cashResult.count=0 signals dedup.
  //   B (audit C-1): one atomic batch → Postgres all-or-nothing BEGIN...COMMIT.
  //      Process kill aborts the whole tx; PI cannot be confirmed without cash.
  //      (Ref: brandur.org/idempotency-keys — atomic phase pattern)
  // pgbouncer: array form only; no await yields inside BEGIN...COMMIT.

  // Normal path: only "pending" is valid (expired intents are early-exited above).
  // Webhook/reopen path: "expired" is also valid (late webhook after in-store expiry).
  const validStates: string[] = ["pending", ...(shouldReopen ? ["expired"] : [])];

  const cashRowData = {
    businessId: input.businessId,
    saleId: intent.saleId ?? null,
    type: "income",
    description: `Cobro QR confirmado (intent ${intent.id})`,
    amount: intent.monto,
    date: now,
    paymentMethod: intentMetodoToPaymentMethod(effectiveMetodo),
    clientMessageId: cashClientMessageId,
  };

  // Conditionally include the sale updateMany only when a sale row exists and
  // has not already been flipped to "paid" (pre-checked via saleShouldUpdate).
  // The batch ops are built before calling $transaction — no branching inside.
  type BatchOp = ReturnType<
    | typeof prisma.paymentIntent.updateMany
    | typeof prisma.sale.updateMany
    | typeof prisma.cashMovement.createMany
  >;

  const piOp = prisma.paymentIntent.updateMany({
    where: {
      id: intent.id,
      businessId: input.businessId,
      estado: { in: validStates as never },
    },
    data: {
      estado: "confirmed",
      confirmedAt: now,
      confirmedByEmployeeId: input.actorEmployeeId,
      ...(input.isWebhookConfirm && intent.metodo !== "checkout_pro_link"
        ? { metodo: "qr_dynamic_real" }
        : {}),
    },
  });

  const saleOp =
    intent.saleId && saleShouldUpdate
      ? prisma.sale.updateMany({
          where: {
            id: intent.saleId,
            businessId: input.businessId,
            status: { not: "paid" },
          },
          data: { status: "paid" },
        })
      : null;

  // createMany with skipDuplicates: true → INSERT ... ON CONFLICT DO NOTHING.
  // Postgres partial unique index on (businessId, clientMessageId) WHERE NOT NULL
  // is the conflict arbiter (migration 20260525900000_add_cashmovement_dedup_key).
  // A duplicate key is silently skipped (count=0) — never throws P2002.
  // Ref: postgresql.org/docs/current/sql-insert.html
  //      brandur.org/idempotency-keys
  const cashOp = prisma.cashMovement.createMany({
    data: [cashRowData],
    skipDuplicates: true,
  });

  const batchOps: BatchOp[] = saleOp
    ? [piOp as BatchOp, saleOp as BatchOp, cashOp as BatchOp]
    : [piOp as BatchOp, cashOp as BatchOp];

  // ── Phase 3 execution — atomic batch ──────────────────────────────────────
  let piResult: { count: number };
  let saleResult: { count: number } | null = null;
  let cashResult: { count: number };

  try {
    if (saleOp) {
      [piResult, saleResult, cashResult] = (await prisma.$transaction(
        batchOps,
      )) as [{ count: number }, { count: number }, { count: number }];
    } else {
      [piResult, cashResult] = (await prisma.$transaction(batchOps)) as [
        { count: number },
        { count: number },
      ];
    }
  } catch (err: unknown) {
    // ITEM 1 — DLQ audit: unexpected batch failure (not a dedup — dedup is
    // silent with skipDuplicates). Record CriticalWriteEvent before re-throwing
    // so the audit trail captures the failed money-path attempt independently
    // of Cloud Tasks DLQ.
    const { isRecordNotFound } = classifyBatchError(err);
    if (!isRecordNotFound) {
      auditBatchFailure(
        input.businessId,
        input.actorEmployeeId,
        input.paymentIntentId,
        Number(intent.monto),
        err,
      );
    }
    throw err;
  }

  // ── Phase 3 post-batch: check results ─────────────────────────────────────

  if (piResult.count === 0) {
    // ITEM 3 — concurrent confirm won the race. Both PI and Cash were no-ops.
    logPiRaceLost(input.businessId, intent.id);
    return { outcome: "already_confirmed" };
  }

  if (saleResult !== null && saleResult.count === 0) {
    // ITEM 4 — concurrent path flipped the sale first. Cash still committed.
    logSaleRaceLost(input.businessId, intent.id, intent.saleId!);
  }

  if (cashResult.count === 0) {
    // ITEM 2 — dedup hit: clientMessageId already existed (prior attempt that
    // committed the cash but died before returning). PI was just confirmed
    // atomically in the same batch. Idempotent — treat as success.
    // WARNING log drives the log-based metric in
    // infra/monitoring/mp-confirm-dedup-metric.yaml. Spike = retry storm.
    logDedupHit(
      input.businessId,
      intent.id,
      intent.saleId,
      Number(intent.monto),
      "CashMovement_businessId_clientMessageId_key",
    );
  }

  return {
    outcome: "confirmed",
    paymentIntentId: intent.id,
    saleId: intent.saleId,
  };
}
