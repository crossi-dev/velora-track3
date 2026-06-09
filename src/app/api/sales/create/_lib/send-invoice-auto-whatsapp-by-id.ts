import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { buildInvoicePdf } from "@/app/api/invoices/[invoiceId]/pdf/build-invoice-pdf";
import { uploadPdfToGcs, getSignedUrlForGcsKey, buildPdfR2Key } from "@/lib/r2";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";

/**
 * Exported replica of the private sendInvoiceAutoWhatsApp logic, callable
 * by the event-retry cron replay handler without importing sale-post-commit.ts.
 *
 * Idempotency: caller must check Invoice.status !== "sent" before calling.
 * On success, stamps Invoice.status = "sent" (same as the original path).
 * Throws on failure so the cron can increment the retry counter.
 */
export async function sendInvoiceAutoWhatsAppById(
  businessId: string,
  saleId: string,
  invoiceId: string,
): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { businessId: true, payloadJson: true, status: true },
  });

  if (!invoice || invoice.businessId !== businessId) {
    throw new Error(`invoice ${invoiceId} not found for business ${businessId}`);
  }

  // Idempotency guard — belt-and-suspenders in case caller already checked.
  if (invoice.status === "sent") return;

  const invoicePayload = JSON.parse(invoice.payloadJson) as InvoicePayload;
  const rawPhone = invoicePayload.customer.phone;
  const customerPhone = typeof rawPhone === "string" ? rawPhone.trim() || null : null;

  if (!customerPhone) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "INVOICE_AUTO_WHATSAPP_SKIPPED",
      a2a_transfer: false,
      message: "invoice auto-send skipped — customer has no phone on file (retry path)",
      businessId,
      data: { saleId, invoiceId, customerName: invoicePayload.customer.name },
    });
    // Mark as sent to stop retries — there is nothing to send without a phone.
    await prisma.invoice.updateMany({
      where: { id: invoiceId, businessId, status: { not: "paid" } },
      data: { status: "sent" },
    });
    return;
  }

  let mediaUrl: string | undefined;
  try {
    const pdfBuffer = await buildInvoicePdf(invoicePayload);
    const key = buildPdfR2Key("invoice", businessId, invoiceId, invoicePayload.sale.invoiceNumber);
    const gcsKey = await uploadPdfToGcs(key, pdfBuffer);
    const signedUrl = gcsKey ? await getSignedUrlForGcsKey(gcsKey) : null;
    if (signedUrl) mediaUrl = signedUrl;
  } catch { /* PDF/GCS failure — fall through to text-only */ }

  const label = invoicePayload.sale.invoiceNumber.startsWith("FC-") ? "factura" : "comprobante";
  const text = `¡Hola! Te enviamos el ${label} por tu compra. Atte: ${invoicePayload.business.name}`;

  // Throws on WA failure — caller (cron) catches and increments retry count.
  await sendWhatsAppMessage(customerPhone, text, mediaUrl);

  await prisma.invoice.updateMany({
    where: { id: invoiceId, businessId, status: { not: "paid" } },
    data: { status: "sent" },
  });

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "INVOICE_AUTO_WHATSAPP_SENT",
    a2a_transfer: false,
    message: "invoice auto-send delivered to customer (retry path)",
    businessId,
    data: { saleId, invoiceId, hasMedia: Boolean(mediaUrl) },
  });
}
