/**
 * sendTransferPaymentRequestWhatsApp — fire-and-forget post-commit dispatcher.
 *
 * Sends an approved Meta WhatsApp template to the customer when a sale is closed
 * with paymentMethod = "transferencia" and the business has an alias configured.
 *
 * Template: velora_transfer_payment_request (must be registered + approved in
 * Meta Business Manager before this reaches production).
 *
 * Gated by TRANSFER_WA_TEMPLATE_ENABLED (default false). Keep disabled until the
 * template is ACTIVE in Meta Business Manager — calling it while PENDING causes
 * a 4xx error that recordPostCommitFailure cannot recover from (paymentRequestSentAt
 * never stamped → infinite silent retry loop on every subsequent sale).
 *
 * Idempotency: Sale.paymentRequestSentAt is stamped on success. Retries see a
 * non-null timestamp and return early without re-sending.
 *
 * @see docs/meta-template-velora_transfer_payment_request.md for registration steps.
 */

import { prisma } from "@/lib/prisma";
import { sendWhatsAppTemplate } from "@/lib/whatsapp";
import { cloudLog } from "@/lib/cloud-logger";
import { recordPostCommitFailure } from "@/app/api/_lib/post-commit-failure-tracker";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";
import { formatARS } from "@/lib/format/money";

const TEMPLATE_NAME = "velora_transfer_payment_request";
const TEMPLATE_LANG = "es_AR";

export async function sendTransferPaymentRequestWhatsApp(
  businessId: string,
  saleId: string,
  invoicePayload: InvoicePayload,
  paymentMethod: string | null,
): Promise<void> {
  // Feature flag: template must be ACTIVE in Meta Business Manager before enabling.
  // Defaults to false to prevent infinite retry loops while template is PENDING REGISTRATION.
  if (process.env.TRANSFER_WA_TEMPLATE_ENABLED !== "true") {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "PAYMENT_REQUEST_WA_TEMPLATE_DISABLED",
      a2a_transfer: false,
      message: "transfer payment request WA skipped — TRANSFER_WA_TEMPLATE_ENABLED is not set",
      businessId,
      data: { saleId },
    });
    return;
  }

  // Only fires for transferencia sales.
  if (paymentMethod !== "transferencia") return;

  const customerPhone = typeof invoicePayload.customer.phone === "string"
    ? invoicePayload.customer.phone.trim()
    : null;

  if (!customerPhone) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "PAYMENT_REQUEST_WA_SKIPPED",
      a2a_transfer: false,
      message: "transfer payment request WA skipped — customer has no phone",
      businessId,
      data: { saleId, reason: "no_phone" },
    });
    return;
  }

  // Fetch alias fresh — not present in InvoicePayload (fiscal snapshot, not payment-routing).
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { alias: true },
  });

  const alias = business?.alias?.trim() || null;
  if (!alias) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "PAYMENT_REQUEST_WA_SKIPPED",
      a2a_transfer: false,
      message: "transfer payment request WA skipped — business has no alias configured",
      businessId,
      data: { saleId, reason: "no_alias" },
    });
    return;
  }

  // Idempotency guard — check if already sent.
  // RLS-verify audit: compound where with businessId — OWASP secure-by-default tenant isolation.
  // businessId is already a param; was previously unused in the where clause.
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, businessId },
    select: { paymentRequestSentAt: true },
  });

  if (sale?.paymentRequestSentAt) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "PAYMENT_REQUEST_WA_SKIPPED",
      a2a_transfer: false,
      message: "transfer payment request WA skipped — already sent",
      businessId,
      data: { saleId, reason: "already_sent", sentAt: sale.paymentRequestSentAt.toISOString() },
    });
    return;
  }

  const firstName = (
    typeof invoicePayload.customer.firstName === "string" && invoicePayload.customer.firstName.trim()
      ? invoicePayload.customer.firstName.trim()
      : invoicePayload.customer.name.split(/\s+/)[0] ?? invoicePayload.customer.name
  );
  const amount = formatARS(invoicePayload.sale.total);

  try {
    await sendWhatsAppTemplate(customerPhone, TEMPLATE_NAME, [
      {
        type: "body",
        parameters: [
          { type: "text", text: firstName },
          { type: "text", text: amount },
          { type: "text", text: alias },
        ],
      },
    ], TEMPLATE_LANG);

    // Atomic check-and-set: if a race already stamped this row, updateMany returns
    // count=0 — that is acceptable and treated as idempotent success.
    await prisma.sale.updateMany({
      where: { id: saleId, paymentRequestSentAt: null },
      data: { paymentRequestSentAt: new Date() },
    });

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "PAYMENT_REQUEST_WA_SENT",
      a2a_transfer: false,
      message: "transfer payment request WhatsApp sent to customer",
      businessId,
      data: { saleId, alias, customerPhone },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "PAYMENT_REQUEST_WA_FAILED",
      a2a_transfer: false,
      message: "transfer payment request WhatsApp failed",
      businessId,
      data: { saleId, error: errorMessage },
    });
    void recordPostCommitFailure({
      businessId,
      saleId,
      action: "PAYMENT_REQUEST_WA_FAILED",
      errorMessage,
    });
    // Do NOT re-throw — sale is already committed; notification is best-effort.
  }
}
