// Notificación unificada al cliente tras confirmar un cobro QR o transferencia.
//
// Reemplaza el texto plano anterior con un mensaje de confirmación de pago
// que adjunta el PDF del comprobante de venta.
//
// Handles both Sale-linked PIs (payloadJson from Invoice) and standalone PIs
// (no Sale — synthesizes a minimal "Pago recibido" payload via buildStandaloneInvoicePayload).
//
// Extraído de payment-intent-post-confirm.ts para mantener ese archivo bajo
// el hard limit de 300 LOC tras agregar el camino B (link de pago).

import { prisma } from "@/lib/prisma";
// Route receipt WPP through Comms agent (single source of truth for customer-facing WPP).
// Direct import is canonical for in-process calls within the same Cloud Run service
// per Google ADK A2A 2026 — mirrors the sendCustomerTrackingWpp pattern.
// Ref: https://google.github.io/adk-docs/agents/multi-agents/#agent-to-agent
import { sendCustomerReceipt } from "@/app/api/agents/communications/jsonrpc/_lib/handle-communications-rpc";
import { cloudLog } from "@/lib/cloud-logger";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";
import {
  buildAndUploadReceiptPdf,
  buildStandaloneInvoicePayload,
  enrichInvoicePayloadWithFiscalFields,
} from "./notify-customer-pdf-helpers";
import { parsePaymentIntentItems } from "./payment-intent-items";

const MAX_ITEMS_SHOWN = 3;

export async function notifyCustomerOnConfirm(
  paymentIntentId: string,
  callerBusinessId: string,
): Promise<void> {
  let phone: string | null = null;
  let customerName: string | null = null;
  let monto = 0;
  let businessId = "";
  let success = false;

  try {
    // findFirst with compound where (callerBusinessId required — no unscoped PI lookup).
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: paymentIntentId, businessId: callerBusinessId },
      select: {
        id: true,
        saleId: true,
        matchedCustomerId: true,
        monto: true,
        confirmedAt: true,
        businessId: true,
        comprobanteSentAt: true,
        // Itemization fields for standalone PI PDF (new path).
        items: true,
        shippingCostARS: true,
        // Courier slug persisted at create time — avoids hardcoded "Andreani".
        // Migración: 20260526T5_add_payment_intent_shipping_courier.
        shippingCourier: true,
        shippingAddress: true,
        business: { select: { name: true } },
      },
    });

    if (!intent) {
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "CUSTOMER_RECEIPT_SENT",
        a2a_transfer: false,
        message: "customer_phone_unavailable: intent not found",
        data: { paymentIntentId, success: false },
      });
      return;
    }

    // G #3: Atomic claim (CAS) — claim-first pattern to close the TOCTOU window.
    //
    // Old order: read comprobanteSentAt → send WA → stamp.
    // Problem: two concurrent retries both read null, both send, only one stamps
    //          → duplicate WA delivered to customer.
    //
    // New order: stamp atomically (WHERE comprobanteSentAt IS NULL) → bail if
    //            count === 0 (another runner claimed it) → send WA → rollback
    //            stamp on transient send error so cron can retry.
    //
    // Sources:
    //   - brandur.org/idempotency-keys — upsert-first, each side-effect gets its
    //     own atomic phase
    //   - dzone.com/articles/phantom-write-idempotency-data-loss — Idempotency
    //     Barrier: claim before act, eliminates 99.98% of duplicate delivery
    const claimTime = new Date();
    const claimed = await prisma.paymentIntent.updateMany({
      where: { id: paymentIntentId, comprobanteSentAt: null },
      data: { comprobanteSentAt: claimTime },
    });

    if (claimed.count === 0) {
      // Another concurrent execution already claimed the stamp — skip.
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "CUSTOMER_RECEIPT_ALREADY_SENT",
        a2a_transfer: false,
        message: "notifyCustomerOnConfirm: lost atomic claim — concurrent runner already stamped, skipping duplicate send",
        data: { paymentIntentId },
        businessId: intent.businessId,
      });
      return;
    }

    monto = Number(intent.monto);
    businessId = intent.businessId;

    // Resolve phone and customer name (findFirst+businessId: tenant guard).
    if (intent.matchedCustomerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: intent.matchedCustomerId, businessId: intent.businessId },
        select: { phone: true, name: true },
      });
      phone = customer?.phone ?? null;
      customerName = customer?.name ?? null;
    }

    // Fetch invoice payload for PDF generation.
    // Sale-linked PI: use Invoice.payloadJson (itemized comprobante).
    // Standalone PI (saleId = null): synthesize minimal "Pago recibido" payload.
    let invoiceId: string | null = null;
    let invoicePayload: InvoicePayload | null = null;

    if (intent.saleId) {
      const sale = await prisma.sale.findFirst({
        where: { id: intent.saleId, businessId: intent.businessId },
        select: {
          shippingQuoteCost: true,
          shippingQuoteCourier: true,
          customer: { select: { phone: true, name: true } },
          saleItems: {
            select: {
              quantity: true,
              product: { select: { name: true } },
            },
            take: MAX_ITEMS_SHOWN + 1,
          },
          invoice: {
            select: { id: true, payloadJson: true },
          },
        },
      });

      if (!phone) phone = sale?.customer?.phone ?? null;
      if (!customerName) customerName = sale?.customer?.name ?? null;

      const invoice = sale?.invoice;
      if (invoice?.id && invoice?.payloadJson) {
        invoiceId = invoice.id;
        try {
          const parsed = JSON.parse(invoice.payloadJson) as InvoicePayload;
          // Enrich payload with shipping line when a pre-pago quote was captured.
          // This ensures the comprobante PDF sent to the customer after payment
          // includes the freight charge as a separate line item.
          const quoteCost = sale?.shippingQuoteCost ? Number(sale.shippingQuoteCost) : null;
          const quoteCourier = sale?.shippingQuoteCourier ?? null;
          invoicePayload = quoteCost && quoteCourier
            ? {
                ...parsed,
                sale: {
                  ...parsed.sale,
                  shippingLine: { courier: quoteCourier, costARS: quoteCost },
                  total: (parsed.sale.total ?? 0) + quoteCost,
                },
              }
            : parsed;
        } catch {
          // Corrupt payloadJson — fall through to text-only message
        }
      }
    } else {
      // Standalone PI — no Sale row. Synthesize PDF payload.
      // New path: use structured items (if present) for an itemized receipt.
      // Legacy path: items=null → "Pago recibido" single-line fallback.
      const parsedItems = parsePaymentIntentItems(intent.items);
      const result = await buildStandaloneInvoicePayload({
        paymentIntentId,
        businessId: intent.businessId,
        monto,
        customerName,
        phone,
        confirmedAt: intent.confirmedAt,
        items: parsedItems,
        shippingCostARS: intent.shippingCostARS ? Number(intent.shippingCostARS) : null,
        // Read courier from DB column (populated at PI create time, backfilled "andreani").
        // Never hardcode — OCA and other couriers write their slug at create time.
        shippingCourier: intent.shippingCourier ?? null,
      });
      if (result) {
        invoiceId = result.invoiceId;
        invoicePayload = result.invoicePayload;
      }
    }

    if (!phone) {
      // No phone to deliver to — roll back the claim so cron can decide what to do,
      // but in practice a missing phone is a permanent condition (not transient), so
      // we leave the stamp in place to avoid an infinite retry loop.
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "CUSTOMER_RECEIPT_SENT",
        a2a_transfer: false,
        message: "customer_phone_unavailable: no phone resolved — keeping claim stamp to prevent retry loop",
        data: { paymentIntentId, success: false },
        businessId: intent.businessId,
      });
      return;
    }

    // Attempt PDF generation only when we have the invoice payload.
    // Sale-linked PIs: enrich with fiscal fields from DB (caeCode, caeFchVto,
    // fiscalTipo, fiscalQrUrl) so the customer PDF includes the CAE block + AFIP
    // QR per RG 2485 + RG 4291 when ARCA_REAL_MODE=true.
    // Standalone PIs (saleId=null): skip enrichment — by design (Branch A 2026-05-26).
    // The payload already has documentType="receipt" (set by buildStandaloneInvoicePayload),
    // so the PDF renders as "COMPROBANTE / sin validez fiscal" with no CAE block.
    // The fiscal Factura C for standalone PIs is emitted separately by the Fiscal
    // Agent (triggerFiscalReceipt → WSFE) and communicated via WhatsApp text.
    // References: AFIP RG 2485 / RG 4291 (CAE on Factura, not on plain receipts).
    let mediaUrl: string | undefined;
    if (invoicePayload && invoiceId) {
      const enriched = intent.saleId
        ? await enrichInvoicePayloadWithFiscalFields(invoicePayload, invoiceId, intent.businessId)
        : invoicePayload;
      mediaUrl = await buildAndUploadReceiptPdf(
        enriched,
        invoiceId,
        intent.businessId,
        paymentIntentId,
      );
    }

    // sendCustomerReceipt throws on WPP send failure so the atomic-claim rollback below fires.
    try {
      await sendCustomerReceipt({
        businessId: intent.businessId,
        customerPhone: phone,
        customerName,
        paymentIntentId,
        monto,
        pdfMediaUrl: mediaUrl,
      });
      success = true;
    } catch (sendErr) {
      // Transient WA send failure — roll back the atomic claim so the cron retries.
      // Rollback is scoped to claimTime to avoid wiping a legitimate stamp from a
      // concurrent winner that somehow raced past count === 0 (extremely unlikely,
      // but defensive).
      await prisma.paymentIntent.updateMany({
        where: { id: paymentIntentId, comprobanteSentAt: claimTime },
        data: { comprobanteSentAt: null },
      });
      throw sendErr; // re-throw so the outer catch logs and the cron retries
    }

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "COMPROBANTE_SENT_AT_STAMPED",
      a2a_transfer: false,
      message: "comprobanteSentAt stamped (atomic claim) after customer receipt send",
      data: { paymentIntentId },
      businessId: intent.businessId,
    });

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "CUSTOMER_RECEIPT_SENT",
      a2a_transfer: false,
      message: `Receipt sent to customer (last4=...${phone.slice(-4)}, pdfAttached=${Boolean(mediaUrl)})`,
      data: {
        paymentIntentId,
        customerPhone: `...${phone.slice(-4)}`,
        pdfAttached: Boolean(mediaUrl),
        success: true,
      },
      businessId: intent.businessId,
    });
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "CUSTOMER_RECEIPT_SENT",
      a2a_transfer: false,
      message: `Receipt send failed: ${err instanceof Error ? err.message : String(err)}`,
      data: {
        paymentIntentId,
        customerPhone: phone ? `...${phone.slice(-4)}` : null,
        success,
      },
      businessId,
    });
  }
}
