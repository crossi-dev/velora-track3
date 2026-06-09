// src/lib/mcp/_lib/velora-delivery-receipt.ts — getDeliveryReceipt implementation.
//
// Returns comprobante + envío data for a confirmed cobro (PaymentIntent).
// Extracted as its own file to stay under the 300-line budget.
//
// Schema findings (verified against prisma/schema.prisma 2026-06-07):
//   Invoice fields used: id, saleId, invoiceNumber, documentType, caeCode (String?),
//     fiscalNumero (Int?), fiscalPtoVta (Int?), fiscalTipo (Int?), fiscalQrUrl (String?),
//     issuedAt, totalAmount, currency
//   AndreaniShipment fields: trackingNumber, service, status, businessId, saleId @unique
//   OcaShipment fields: trackingNumber, service, status, businessId, saleId @unique
//   PaymentIntent: saleId? → Sale → invoice? + andreaniShipment? + ocaShipment?
//   NO generic Shipment model — two concrete carriers: AndreaniShipment + OcaShipment.
//
// comprobante kind logic:
//   kind="factura" ONLY when Invoice.caeCode IS NOT NULL (a real ARCA/AFIP CAE exists).
//   kind="comprobante" in all other cases (documentType="receipt", sandbox, or no fiscal creds).
//   AFIP-flexible: never assume a CAE exists.
//
// envio: resolves AndreaniShipment first, then OcaShipment.
//   null when neither table has a row for the sale (honest "no envío" state).
//
// UCP fulfillment (spec: https://ucp.dev/latest/specification/order/ — HTTP 200 verified):
//   UCP fulfillment.events[] has: id, occurred_at, type, tracking_number, carrier, description.
//   We populate it when a shipment row exists. Carried as a Velora extension in prefill
//   when envio is null (UCP requires fulfillment; we emit an empty events array in that case).
//
// Tenant isolation: businessId ALWAYS comes from the tenantId input field.
// READ-ONLY — no mutations.

import type { GetDeliveryReceiptInput, DeliveryReceipt, DeliveryEnvio } from "./payments-backend.port";
import { resolveCustomerIdByName } from "@/app/api/agents/payments/jsonrpc/_lib/payments-agent-helpers";
import { prisma } from "@/lib/prisma";

// ── Internal helpers ──────────────────────────────────────────────────────────

interface ShipmentRow {
  carrier: string;
  trackingNumber: string;
  status: string;
}

/** Tries AndreaniShipment first, then OcaShipment. Returns null if neither has a row for this sale. */
async function resolveShipment(businessId: string, saleId: string): Promise<ShipmentRow | null> {
  const andreani = await prisma.andreaniShipment.findFirst({
    where: { businessId, saleId },
    select: { trackingNumber: true, status: true },
  });
  if (andreani) {
    return { carrier: "Andreani", trackingNumber: andreani.trackingNumber, status: andreani.status };
  }

  const oca = await prisma.ocaShipment.findFirst({
    where: { businessId, saleId },
    select: { trackingNumber: true, status: true },
  });
  if (oca) {
    return { carrier: "OCA", trackingNumber: oca.trackingNumber, status: oca.status };
  }

  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Returns the delivery receipt for a confirmed cobro, or null when not found.
 * Resolves by paymentIntentId, saleId, or customerName (at least one required).
 * The caller must guard before calling (returns null if all are absent).
 */
export async function getDeliveryReceiptImpl(
  input: GetDeliveryReceiptInput,
): Promise<DeliveryReceipt | null> {
  const { tenantId: businessId, paymentIntentId, saleId, customerName } = input;

  if (!paymentIntentId && !saleId && !customerName) return null;

  let resolvedSaleId: string | null = saleId ?? null;

  // Resolve via PaymentIntent path (paymentIntentId or customerName → PI → saleId)
  if (!resolvedSaleId) {
    let resolvedIntentId = paymentIntentId ?? null;

    if (!resolvedIntentId && customerName) {
      const customerId = await resolveCustomerIdByName(businessId, customerName);
      if (!customerId) return null;
      const intent = await prisma.paymentIntent.findFirst({
        where: { businessId, matchedCustomerId: customerId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!intent) return null;
      resolvedIntentId = intent.id;
    }

    if (resolvedIntentId) {
      const pi = await prisma.paymentIntent.findFirst({
        where: { id: resolvedIntentId, businessId },
        select: { saleId: true },
      });
      if (!pi) return null;
      resolvedSaleId = pi.saleId ?? null;
    }
  }

  if (!resolvedSaleId) return null;

  // Full detail fetch: Sale + saleItems + customer + invoice + shipments
  const sale = await prisma.sale.findFirst({
    where: { id: resolvedSaleId, businessId },
    select: {
      id: true,
      customer: { select: { name: true, phone: true } },
      saleItems: {
        select: {
          productId: true,
          quantity: true,
          unitPrice: true,
          product: { select: { name: true } },
        },
      },
      invoice: {
        select: {
          invoiceNumber: true,
          documentType: true,
          caeCode: true,
          fiscalNumero: true,
          fiscalPtoVta: true,
          fiscalTipo: true,
          fiscalQrUrl: true,
          totalAmount: true,
          currency: true,
        },
      },
    },
  });

  if (!sale) return null;

  // Items
  const items = sale.saleItems.map((si) => ({
    productId: si.productId ?? null,
    name: si.product?.name ?? "Producto",
    quantity: si.quantity,
    unitPrice: Number(si.unitPrice),
  }));

  const totalARS = items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);

  // comprobante — kind="factura" only when a real CAE exists
  let comprobante: DeliveryReceipt["comprobante"];
  if (sale.invoice) {
    const inv = sale.invoice;
    const hasCae = typeof inv.caeCode === "string" && inv.caeCode.length > 0;
    if (hasCae) {
      // Real ARCA/AFIP factura
      const tipoLabel =
        inv.fiscalTipo === 1 ? "Factura A" :
        inv.fiscalTipo === 6 ? "Factura B" :
        inv.fiscalTipo === 11 ? "Factura C" :
        "Factura";
      const ptoVta = inv.fiscalPtoVta ?? 1;
      const nro = inv.fiscalNumero ?? 0;
      const formatted = `${String(ptoVta).padStart(4, "0")}-${String(nro).padStart(8, "0")}`;
      comprobante = {
        kind: "factura",
        label: tipoLabel,
        number: formatted,
        ...(inv.fiscalQrUrl ? { pdfUrl: inv.fiscalQrUrl } : {}),
      };
    } else {
      // Invoice row exists but no CAE → comprobante simple
      comprobante = {
        kind: "comprobante",
        label: "Comprobante de venta",
        number: inv.invoiceNumber,
      };
    }
  } else {
    // No invoice row at all
    comprobante = { kind: "comprobante", label: "Comprobante de venta" };
  }

  // envio — try Andreani then OCA; null = no shipping row
  const shipmentRow = await resolveShipment(businessId, resolvedSaleId);
  const envio: DeliveryEnvio | null = shipmentRow
    ? {
        carrier: shipmentRow.carrier,
        tracking: shipmentRow.trackingNumber,
        status: shipmentRow.status,
      }
    : null;

  return {
    saleId: resolvedSaleId,
    customerName: sale.customer?.name ?? "Desconocido",
    customerPhone: sale.customer?.phone ?? null,
    items,
    totalARS,
    comprobante,
    envio,
  };
}
