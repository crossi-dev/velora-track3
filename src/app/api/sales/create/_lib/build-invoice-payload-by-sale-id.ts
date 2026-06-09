import { prisma } from "@/lib/prisma";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";

/**
 * Reconstructs the InvoicePayload for a sale from the persisted Invoice.payloadJson.
 * Returns null if the invoice does not exist or the payload cannot be parsed.
 *
 * Used by the event-retry cron to rebuild the full payload needed to replay
 * post-commit actions (e.g. PAYMENT_REQUEST_WA_FAILED) without re-running
 * the full sale transaction.
 */
export async function buildInvoicePayloadBySaleId(
  businessId: string,
  saleId: string,
): Promise<InvoicePayload | null> {
  const invoice = await prisma.invoice.findUnique({
    where: { saleId },
    select: { businessId: true, payloadJson: true },
  });

  if (!invoice || invoice.businessId !== businessId) return null;

  try {
    return JSON.parse(invoice.payloadJson) as InvoicePayload;
  } catch {
    return null;
  }
}
