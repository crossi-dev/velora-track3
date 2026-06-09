// PDF helpers for notify-customer-on-confirm.ts.
// Extracted to keep notify-customer-on-confirm.ts under the 300-line hard limit.
//
// buildAndUploadReceiptPdf — builds a PDF buffer and uploads to GCS.
// buildStandaloneInvoicePayload — synthesizes a minimal InvoicePayload for
//   standalone PaymentIntents (no Sale linked). Single-line "Pago recibido"
//   receipt instead of an itemized sale comprobante.
// enrichInvoicePayloadWithFiscalFields — reads caeCode/caeFchVto/fiscalTipo/
//   fiscalQrUrl from the Invoice DB row and merges them into the payload.
//   Used by both customer PDF paths so CAE block + AFIP QR (RG 2485 + RG 4291)
//   are present whenever ARCA_REAL_MODE=true has already populated those columns.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { buildInvoicePdf } from "@/app/api/invoices/[invoiceId]/pdf/build-invoice-pdf";
import { uploadPdfToGcs, getSignedUrlForGcsKey, buildPdfR2Key } from "@/lib/r2";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";
import type { InvoicePdfPayload } from "@/app/api/invoices/[invoiceId]/pdf/invoice-pdf-types";
import {
  parsePaymentIntentItems,
  sumItemSubtotals,
  type PaymentIntentItems,
} from "./payment-intent-items";

/**
 * Generates a PDF comprobante and uploads it to GCS.
 * Returns the signed URL on success, or undefined when GCS is not configured
 * or any error occurs (caller falls back to text-only WhatsApp message).
 */
export async function buildAndUploadReceiptPdf(
  invoicePayload: InvoicePayload | InvoicePdfPayload,
  invoiceId: string,
  businessId: string,
  paymentIntentId: string,
): Promise<string | undefined> {
  try {
    const pdfBuffer = await buildInvoicePdf(invoicePayload as InvoicePdfPayload);
    const key = buildPdfR2Key(
      "invoice",
      businessId,
      invoiceId,
      invoicePayload.sale.invoiceNumber,
    );
    const gcsKey = await uploadPdfToGcs(key, pdfBuffer);
    const signedUrl = gcsKey ? await getSignedUrlForGcsKey(gcsKey) : null;
    return signedUrl ?? undefined;
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "CONFIRM_RECEIPT_PDF_FAILED",
      a2a_transfer: false,
      message: `PDF generation/upload failed — sending text-only: ${err instanceof Error ? err.message : String(err)}`,
      businessId,
      data: { paymentIntentId, invoiceId },
    });
    return undefined;
  }
}

/**
 * Synthesizes an InvoicePayload for a standalone PaymentIntent
 * (saleId = null — cobro suelto created via chat without a Sale row).
 *
 * When `items` is populated (new path):
 *   - Renders each item as a PDF line (productName, qty, unitPrice, subtotal).
 *   - When shippingCostARS > 0, appends an "Envío Andreani" shipping line.
 *   - Validates that sum(subtotals) + shippingCostARS === monto (logs WARNING on mismatch).
 *
 * When `items` is null (legacy path):
 *   - Falls back to the single-line "Pago recibido $X" receipt.
 *
 * Refs:
 *   Stripe PaymentIntents metadata §structured-data (line-items on PI, not Session)
 *   MP Preference.items schema 2026 (title/quantity/unit_price per line)
 *   AFIP RG 2485 + RG 4291 (name, qty, unitPrice, subtotal, shipping discriminated, total)
 *
 * No DB Invoice row is created. The synthetic invoiceId
 * (`standalone-{paymentIntentId}`) is used only for GCS key naming.
 *
 * Returns null when the Business row cannot be found (should never happen
 * in practice but is handled defensively).
 */
export async function buildStandaloneInvoicePayload(args: {
  paymentIntentId: string;
  businessId: string;
  monto: number;
  customerName: string | null;
  phone: string | null;
  confirmedAt: Date | null;
  /** Parsed line items from PaymentIntent.items column. Null → legacy fallback. */
  items: PaymentIntentItems | null;
  /** Shipping cost in ARS. Null or 0 → no shipping line. */
  shippingCostARS: number | null;
  /** Courier name for the shipping label (e.g. "Andreani"). Defaults to "Andreani". */
  shippingCourier?: string | null;
}): Promise<{ invoiceId: string; invoicePayload: InvoicePayload } | null> {
  const business = await prisma.business.findUnique({
    where: { id: args.businessId },
    select: {
      name: true,
      address: true,
      cuit: true,
      ivaCondition: true,
      currency: true,
    },
  });

  if (!business) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "BUSINESS_NOT_FOUND_STANDALONE_RECEIPT",
      a2a_transfer: false,
      message: `buildStandaloneInvoicePayload: business row missing — cannot generate standalone receipt PDF`,
      data: { paymentIntentId: args.paymentIntentId, businessId: args.businessId },
    });
    return null;
  }

  const paymentDate = args.confirmedAt ?? new Date();
  const invoiceId = `standalone-${args.paymentIntentId}`;

  // ── Build line items ──────────────────────────────────────────────────────
  // New path: use structured items from the PI column + optional shipping line.
  // Legacy path: fall back to single "Pago recibido" line when items is null.
  const hasItems = args.items !== null && args.items.length > 0;
  const shippingCost = args.shippingCostARS && args.shippingCostARS > 0
    ? args.shippingCostARS
    : null;

  let saleItems: InvoicePayload["sale"]["items"];
  let total: number;
  let shippingLine: InvoicePayload["sale"]["shippingLine"] | undefined;

  if (hasItems && args.items) {
    // Typed path — render real line items.
    saleItems = args.items.map((it) => ({
      productName: it.productName,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      subtotal: it.subtotal,
    }));

    // Add shipping as a discriminated shippingLine (not a sale item),
    // per AFIP RG 2485 (flete discriminado) and MP Preference.items convention.
    if (shippingCost) {
      const courier = args.shippingCourier ?? "Andreani";
      shippingLine = { courier, costARS: shippingCost };
    }

    total = sumItemSubtotals(args.items) + (shippingCost ?? 0);

    // Sanity check — log a WARNING when the computed total diverges from monto.
    // Mismatch indicates the caller constructed items incorrectly; the PDF still
    // renders (fail-open) but ops can investigate via the WARNING log.
    const montoRounded = Math.round(args.monto * 100);
    const totalRounded = Math.round(total * 100);
    if (montoRounded !== totalRounded) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "STANDALONE_PDF_TOTAL_MISMATCH",
        a2a_transfer: false,
        message: `buildStandaloneInvoicePayload: computed total (${total}) ≠ monto (${args.monto}) — PDF renders with computed total`,
        data: {
          paymentIntentId: args.paymentIntentId,
          monto: args.monto,
          computedTotal: total,
          itemsSubtotal: sumItemSubtotals(args.items),
          shippingCost: shippingCost ?? 0,
        },
      });
    }
  } else {
    // Legacy fallback — single line covering the full monto.
    saleItems = [
      {
        productName: "Pago recibido",
        quantity: 1,
        unitPrice: args.monto,
        subtotal: args.monto,
      },
    ];
    total = args.monto;
  }

  // Standalone PI PDF = Recibo de pago (NOT a fiscal Factura).
  //
  // Decision (Branch A, 2026-05-26): per AFIP RG 2485 / RG 4291, a standalone
  // PaymentIntent (saleId=null) is a payment confirmation receipt — informational,
  // not a legally-binding fiscal document. The fiscal Factura C is emitted
  // separately by the Fiscal Agent (A2A) via WSFE when ARCA_REAL_MODE=true.
  //
  // This separation mirrors the Stripe 2026 canonical pattern (Receipt vs Invoice):
  //   https://stripe.com/resources/more/is-an-invoice-a-receipt
  // And the AR merchant obligation: MP's own receipt does NOT substitute the
  // seller's AFIP Factura obligation:
  //   https://www.wetrex.agency/elearning/contable/facturar-con-mercado-pago/
  //
  // Setting documentType="receipt" on the payload ensures the PDF renderer
  // always shows "COMPROBANTE / sin validez fiscal" for this document —
  // never "FACTURA" with a missing CAE block, which would be misleading and
  // non-compliant if delivered as a substitute for the fiscal Factura.
  const invoicePayload: InvoicePayload = {
    documentType: "receipt",
    business: {
      name: business.name,
      address: business.address ?? null,
      cuit: business.cuit ?? null,
      currency: business.currency,
      ivaCondition: business.ivaCondition ?? null,
    },
    customer: {
      name: args.customerName ?? "Cliente",
      taxId: null,
      email: null,
      phone: args.phone ?? null,
    },
    sale: {
      id: args.paymentIntentId,
      invoiceNumber: `REC-0001-${args.paymentIntentId.slice(-8).toUpperCase()}`,
      date: paymentDate.toISOString(),
      items: saleItems,
      total,
      ...(shippingLine ? { shippingLine } : {}),
    },
  };

  return { invoiceId, invoicePayload };
}

/**
 * Fetches the authoritative fiscal fields (caeCode, caeFchVto, fiscalTipo,
 * fiscalQrUrl) from the Invoice DB row and merges them into the given payload.
 *
 * These columns are only populated after a successful ARCA WSFE call
 * (ARCA_REAL_MODE=true). When absent the payload is returned unchanged and
 * the PDF omits the CAE block — matching sandbox / non-fiscal behaviour.
 *
 * Mirrors the injection pattern in invoices/[invoiceId]/pdf/route.ts:90-102.
 * Mandatory per AFIP RG 2485 (CAE + Vto. CAE) and RG 4291 (QR code).
 */
export async function enrichInvoicePayloadWithFiscalFields(
  payload: InvoicePayload,
  invoiceId: string,
  businessId?: string,
): Promise<InvoicePdfPayload> {
  const base = payload as InvoicePdfPayload;
  try {
    // RLS-verify audit: use findFirst with compound where (id + businessId) for tenant isolation.
    // findUnique only accepts @id/@unique fields, so findFirst is required for compound filtering.
    // OWASP secure-by-default: a leaked invoiceId cannot resolve cross-tenant when businessId scopes it.
    const row = businessId
      ? await prisma.invoice.findFirst({
          where: { id: invoiceId, businessId },
          select: { fiscalTipo: true, caeCode: true, caeFchVto: true, fiscalQrUrl: true },
        })
      : await prisma.invoice.findUnique({
          where: { id: invoiceId },
          select: { fiscalTipo: true, caeCode: true, caeFchVto: true, fiscalQrUrl: true },
        });
    if (!row) return base;

    // Inject fiscal fields from DB — authoritative after CAE emission.
    // These override any stale or missing values in the stored payloadJson.
    const enriched: InvoicePdfPayload = { ...base };
    if (row.fiscalTipo != null) enriched.fiscalTipo = row.fiscalTipo;
    if (row.caeCode != null) enriched.caeCode = row.caeCode;
    if (row.caeFchVto != null) enriched.caeFchVto = row.caeFchVto.toISOString();
    if (row.fiscalQrUrl != null) enriched.fiscalQrUrl = row.fiscalQrUrl;
    return enriched;
  } catch {
    // Non-fatal — return base payload; PDF renders without CAE block
    return base;
  }
}
