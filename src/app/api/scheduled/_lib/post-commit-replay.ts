import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";
import { checkThresholdCrossings } from "@/app/api/planner/_lib/planner-threshold";
import { sendTransferPaymentRequestWhatsApp } from "@/app/api/sales/create/_lib/transfer-payment-request-wa";
import type { PostCommitPayload } from "@/app/api/_lib/post-commit-failure-publisher";
import { replayComprobanteSend, replayShipmentCreate } from "./post-commit-replay.payment";

// Dispatch table for replaying post-commit failures picked up by the event-retry cron.
// Each handler must be fully idempotent — the cron may call it multiple times.
//
// Idempotency strategy per action:
//   INVOICE_AUTO_WHATSAPP_FAILED     → check Invoice.status === "sent" before re-sending.
//   PAYMENT_REQUEST_WA_FAILED        → check Sale.paymentRequestSentAt != null before re-sending.
//                                      sendTransferPaymentRequestWhatsApp has its own guard.
//   SALE_CONFIRMATION_PUSH_FAILED    → check ChatMessage with clientMessageId="sale-confirmation-{saleId}".
//                                      If the chat row exists, the push is the only missing piece.
//   PLANNER_THRESHOLD_TRIGGER_FAILED → re-invoke checkThresholdCrossings; it uses
//                                      P2002-deduped clientMessageId per product per day.
//   COMPROBANTE_SEND_FAILED          → see post-commit-replay.payment.ts.
//                                      C-2 FIX: payment-intent-post-confirm.ts comments claimed this
//                                      retry existed, but it was never wired. Now it is.
//   SHIPMENT_CREATE_FAILED           → see post-commit-replay.payment.ts.
//                                      C-1 FIX: previously the comment "retry eligible" was a lie —
//                                      post-commit-replay had no handler for this action. Now wired.

export type ReplayResult =
  | { status: "replayed" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export async function replayPostCommitAction(
  businessId: string,
  payload: PostCommitPayload,
): Promise<ReplayResult> {
  const { action, saleId } = payload;

  switch (action) {
    case "INVOICE_AUTO_WHATSAPP_FAILED":
      return replayInvoiceAutoWhatsApp(businessId, saleId, payload.originalArgs);

    case "PAYMENT_REQUEST_WA_FAILED":
      return replayPaymentRequestWa(businessId, saleId);

    case "SALE_CONFIRMATION_PUSH_FAILED":
      return replaySaleConfirmationPush(businessId, saleId);

    case "PLANNER_THRESHOLD_TRIGGER_FAILED":
      return replayPlannerThreshold(businessId, saleId);

    case "COMPROBANTE_SEND_FAILED":
      return replayComprobanteSend(businessId, payload.originalArgs);

    case "SHIPMENT_CREATE_FAILED":
      return replayShipmentCreate(businessId, payload.originalArgs);

    default:
      return { status: "skipped", reason: `unknown action: ${action}` };
  }
}

// ---------------------------------------------------------------------------
// Individual replay handlers
// ---------------------------------------------------------------------------

async function replayInvoiceAutoWhatsApp(
  businessId: string,
  saleId: string | null | undefined,
  originalArgs: Record<string, unknown> | undefined,
): Promise<ReplayResult> {
  const invoiceId = typeof originalArgs?.["invoiceId"] === "string" ? originalArgs["invoiceId"] : null;
  if (!invoiceId || !saleId) {
    return { status: "skipped", reason: "missing invoiceId or saleId in originalArgs" };
  }

  // Idempotency: if invoice is already "sent", skip.
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { status: true, businessId: true },
  });
  if (!invoice || invoice.businessId !== businessId) {
    return { status: "skipped", reason: "invoice not found" };
  }
  if (invoice.status === "sent") {
    return { status: "skipped", reason: "invoice already sent" };
  }

  // Re-import the send function at call time to avoid circular dep at module load.
  // The function rebuilds the PDF and sends — same path as the original post-commit.
  try {
    const { sendInvoiceAutoWhatsAppById } = await import(
      "@/app/api/sales/create/_lib/send-invoice-auto-whatsapp-by-id"
    );
    await sendInvoiceAutoWhatsAppById(businessId, saleId, invoiceId);
    return { status: "replayed" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

async function replayPaymentRequestWa(
  businessId: string,
  saleId: string | null | undefined,
): Promise<ReplayResult> {
  if (!saleId) return { status: "skipped", reason: "missing saleId" };

  // sendTransferPaymentRequestWhatsApp has a built-in idempotency guard
  // (Sale.paymentRequestSentAt). We need the InvoicePayload to call it.
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    select: {
      paymentRequestSentAt: true,
      paymentMethod: true,
      businessId: true,
    },
  });

  if (!sale || sale.businessId !== businessId) {
    return { status: "skipped", reason: "sale not found" };
  }
  if (sale.paymentRequestSentAt) {
    return { status: "skipped", reason: "payment request already sent" };
  }

  // Rebuild the InvoicePayload from the invoice linked to the sale.
  try {
    const { buildInvoicePayloadBySaleId } = await import(
      "@/app/api/sales/create/_lib/build-invoice-payload-by-sale-id"
    );
    const invoicePayload = await buildInvoicePayloadBySaleId(businessId, saleId);
    if (!invoicePayload) return { status: "skipped", reason: "invoice payload not found" };

    await sendTransferPaymentRequestWhatsApp(businessId, saleId, invoicePayload, sale.paymentMethod);
    return { status: "replayed" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

async function replaySaleConfirmationPush(
  businessId: string,
  saleId: string | null | undefined,
): Promise<ReplayResult> {
  if (!saleId) return { status: "skipped", reason: "missing saleId" };

  // The ChatMessage was already written (push is what failed). Re-send push only.
  // Idempotency: sendPushToOwner is best-effort fan-out — duplicate push is
  // acceptable and preferred over silent miss. We check the sale still exists.
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    select: { businessId: true },
  });
  if (!sale || sale.businessId !== businessId) {
    return { status: "skipped", reason: "sale not found" };
  }

  try {
    const chatMsg = await prisma.chatMessage.findFirst({
      where: { businessId, clientMessageId: `sale-confirmation-${saleId}` },
      select: { text: true },
    });
    const body = chatMsg?.text?.slice(0, 120) ?? `Venta ${saleId} registrada.`;

    await sendPushToOwner(businessId, {
      title: "Velora · Venta registrada",
      body,
      url: "/dashboard",
      notificationCategory: "sale_confirmation",
      entityId: saleId,
    });
    return { status: "replayed" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

async function replayPlannerThreshold(
  businessId: string,
  saleId: string | null | undefined,
): Promise<ReplayResult> {
  if (!saleId) return { status: "skipped", reason: "missing saleId" };

  // Re-derive low-stock alerts from the sale items + current stock levels.
  // checkThresholdCrossings is idempotent via P2002 on clientMessageId per product per day.
  try {
    const saleItems = await prisma.saleItem.findMany({
      where: { saleId },
      select: {
        productId: true,
        product: { select: { name: true, quantity: true, reorderThreshold: true } },
      },
    });

    type SaleItemWithProduct = typeof saleItems[number] & {
      productId: string;
      product: NonNullable<typeof saleItems[number]["product"]>;
    };
    const alerts = saleItems
      .filter((si): si is SaleItemWithProduct => {
        const p = si.product;
        return si.productId != null && p != null && p.quantity <= p.reorderThreshold;
      })
      .map((si) => ({
        productId: si.productId,
        productName: si.product.name,
        remainingUnits: si.product.quantity,
      }));

    if (alerts.length === 0) {
      return { status: "skipped", reason: "no products below threshold at replay time" };
    }

    await checkThresholdCrossings(businessId, alerts);
    return { status: "replayed" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

// Backoff schedule (attempt index is 0-based: 0 = first retry after failure)
const BACKOFF_MS = [
  1 * 60 * 1000,      // attempt 0 → 1 min
  5 * 60 * 1000,      // attempt 1 → 5 min
  15 * 60 * 1000,     // attempt 2 → 15 min
  60 * 60 * 1000,     // attempt 3 → 1 h
  6 * 60 * 60 * 1000, // attempt 4 → 6 h
] as const;

export const MAX_RETRIES = BACKOFF_MS.length; // 5

/** Returns true if enough time has elapsed since last processedAt for the given retry count. */
export function isBackoffElapsed(retries: number, processedAt: Date | null, nowMs: number): boolean {
  if (retries >= MAX_RETRIES) return false; // exhausted — don't retry
  const cooldown = BACKOFF_MS[retries] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
  const lastAttemptMs = processedAt ? processedAt.getTime() : 0;
  return nowMs - lastAttemptMs >= cooldown;
}

export function logCriticalPersistentFailure(
  businessId: string,
  eventId: string,
  action: string,
  saleId: string | null | undefined,
  lastError: string,
): void {
  cloudLog({
    severity: "CRITICAL",
    component: "System",
    action: "POST_COMMIT_ACTION_PERMANENTLY_FAILED",
    a2a_transfer: false,
    message: `post-commit action exhausted all ${MAX_RETRIES} retry attempts — operator intervention required`,
    businessId,
    data: { eventId, action, saleId, lastError },
  });
}
