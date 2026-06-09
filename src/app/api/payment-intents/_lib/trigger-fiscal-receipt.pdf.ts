// PDF enrichment helper for trigger-fiscal-receipt.ts (Camino A — checkout_pro_link).
// Extracted to keep trigger-fiscal-receipt.ts under the 300-line hard limit.
//
// buildAndAttachReceiptPdf — fetches the Sale's Invoice.payloadJson (or synthesizes
// a standalone payload), enriches it with shippingLine when a quote was captured,
// injects fiscal fields from the DB Invoice row (caeCode/caeFchVto/fiscalTipo/
// fiscalQrUrl — mandatory per AFIP RG 2485 + RG 4291 when ARCA_REAL_MODE=true),
// and delegates PDF generation + upload to buildAndUploadReceiptPdf.
//
// Returns the signed URL on success, or undefined on any failure (caller falls back
// to text-only WhatsApp message — same fallback pattern as notify-customer-on-confirm.ts).
//
// ── Standalone PI PDF design (Branch A, 2026-05-26) ─────────────────────────────
// When saleId=null, the PDF generated here is a "Recibo de pago" (payment confirmation
// receipt), NOT a fiscal Factura. The fiscal Factura C is emitted by the Fiscal Agent
// via ARCA WSFE (triggerFiscalReceipt → A2A) and communicated to the customer via the
// agent's narrative WhatsApp text. This PDF is a secondary informational attachment.
//
// CAE fields are intentionally NOT injected for standalone PIs:
//   1. There is no Invoice DB row to read CAE from (no Sale → no Invoice).
//   2. The fiscal document (Factura C with CAE) is the WSFE output, not this PDF.
//   3. Injecting CAE from a different Sale's Invoice would be incorrect.
//
// The PDF renders with documentType="receipt" (set by buildStandaloneInvoicePayload),
// which produces "COMPROBANTE / sin validez fiscal" in the header — correct labeling
// per AFIP 2026 for a non-fiscal payment confirmation document.
//
// References:
//   AFIP RG 2485 — CAE mandatory on Factura Electrónica, not on plain receipts.
//   AFIP RG 4291/2018 — QR mandatory on electronic invoices (Facturas), not receipts.
//   Stripe 2026 receipts vs invoices: https://stripe.com/resources/more/is-an-invoice-a-receipt
//   AR merchant fiscal obligation (MP does not substitute AFIP Factura):
//     https://www.wetrex.agency/elearning/contable/facturar-con-mercado-pago/

import { prisma } from "@/lib/prisma";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";
import {
  buildAndUploadReceiptPdf,
  buildStandaloneInvoicePayload,
  enrichInvoicePayloadWithFiscalFields,
} from "./notify-customer-pdf-helpers";

/**
 * Resolves the receipt PDF URL for a PaymentIntent.
 *
 * - If `saleId` is set: reads `Sale.invoice.payloadJson`, enriches with shippingLine
 *   (and adds quoteCost to total when present), injects DB fiscal fields
 *   (caeCode, caeFchVto, fiscalTipo, fiscalQrUrl), then builds + uploads the PDF.
 * - If `saleId` is null: synthesizes a minimal "Pago recibido" payload via
 *   `buildStandaloneInvoicePayload` (no CAE — standalone PIs have no Invoice row).
 *
 * Returns the signed GCS URL or undefined (caller falls back to text-only send).
 */
export async function buildAndAttachReceiptPdf(args: {
  paymentIntentId: string;
  businessId: string;
  saleId: string | null;
  monto: number;
  customerName: string;
  phone: string;
  confirmedAt: Date | null;
}): Promise<string | undefined> {
  const { paymentIntentId, businessId, saleId, monto, customerName, phone, confirmedAt } = args;

  let invoiceId: string | null = null;
  let invoicePayload: InvoicePayload | null = null;

  if (saleId) {
    const sale = await prisma.sale.findFirst({
      where: { id: saleId, businessId },
      select: {
        shippingQuoteCost: true,
        shippingQuoteCourier: true,
        invoice: {
          select: { id: true, payloadJson: true },
        },
      },
    });

    const invoice = sale?.invoice;
    if (invoice?.id && invoice?.payloadJson) {
      invoiceId = invoice.id;
      try {
        const parsed = JSON.parse(invoice.payloadJson) as InvoicePayload;
        const quoteCost = sale?.shippingQuoteCost ? Number(sale.shippingQuoteCost) : null;
        const quoteCourier = sale?.shippingQuoteCourier ?? null;
        if (quoteCost && quoteCourier) {
          invoicePayload = {
            ...parsed,
            sale: {
              ...parsed.sale,
              // Correctly sum freight into the grand total (C-4 fix: total includes
              // shippingLine cost so the PDF reflects what the customer actually paid).
              total: parsed.sale.total + quoteCost,
              shippingLine: { courier: quoteCourier, costARS: quoteCost },
            },
          };
        } else {
          invoicePayload = parsed;
        }
      } catch {
        // Corrupt payloadJson — fall through to undefined (text-only fallback)
        return undefined;
      }
    }
  } else {
    // Standalone PI — synthesize itemized payload when PI.items is populated.
    // Fetch items + shippingCostARS from DB (Camino A receives the PI by ID, not the full row).
    // RLS-verify audit: compound where with businessId — OWASP secure-by-default tenant isolation.
    // businessId is already a param — was previously unused in the where clause.
    const piRow = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId, businessId },
      select: {
        items: true,
        shippingCostARS: true,
        // Courier slug persisted at PI create time — avoids hardcoded "Andreani".
        // Migración: 20260526T5_add_payment_intent_shipping_courier.
        shippingCourier: true,
      },
    });
    const { parsePaymentIntentItems } = await import("./payment-intent-items");
    const parsedItems = parsePaymentIntentItems(piRow?.items ?? null);
    const result = await buildStandaloneInvoicePayload({
      paymentIntentId,
      businessId,
      monto,
      customerName,
      phone,
      confirmedAt,
      items: parsedItems,
      shippingCostARS: piRow?.shippingCostARS ? Number(piRow.shippingCostARS) : null,
      // Read from DB — never hardcode. OCA and other couriers write their slug at create time.
      shippingCourier: piRow?.shippingCourier ?? null,
    });
    if (result) {
      invoiceId = result.invoiceId;
      invoicePayload = result.invoicePayload;
    }
  }

  if (!invoicePayload || !invoiceId) return undefined;

  // Inject fiscal fields from the Invoice DB row so the customer PDF includes
  // the CAE block + AFIP QR when ARCA_REAL_MODE=true has populated those columns.
  // No-op when caeCode is null (sandbox / non-fiscal) — PDF silently skips that block.
  const enriched = saleId
    ? await enrichInvoicePayloadWithFiscalFields(invoicePayload, invoiceId, businessId)
    : invoicePayload;

  return buildAndUploadReceiptPdf(enriched, invoiceId, businessId, paymentIntentId);
}
