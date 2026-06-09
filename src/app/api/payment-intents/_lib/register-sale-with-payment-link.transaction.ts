// register-sale-with-payment-link.transaction.ts — Atomic DB write for the
// Checkout Pro / payment-link flow. Contains the $transaction body extracted
// from the use-case to keep both files under the 300-line server/api hard limit.
//
// Steps committed in a single Prisma transaction:
//   1. Sale (status="pending", paymentMethod="checkout_pro_link")
//   2. SaleItems — denormalized for immutability
//   3. Inventory decrement (respects allowNegativeStock)
//   4. Invoice (fully-grounded payloadJson)
//   5. PaymentIntent (pending, checkout_pro_link, saleId bound)
//
// References: see use-case file for [1]-[4] citation list.

import type { Prisma } from "@prisma/client";
import {
  nextInvoiceSequenceNumber,
  buildSaleInvoicePayload,
} from "@/infrastructure/shared/sale-invoice";
import { computeTaxAmount } from "@/lib/money";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResolvedLinkItem = {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type ResolvedLinkCustomer = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  dni: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
};

export type LinkSaleTxResult = {
  sale: { id: string };
  invoice: { id: string };
  pi: { id: string };
};

// ---------------------------------------------------------------------------
// Transaction body
// ---------------------------------------------------------------------------

export async function runSaleWithPaymentLinkTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    customer: ResolvedLinkCustomer;
    resolvedItems: ResolvedLinkItem[];
    grandTotal: number;
    shippingCost: number;
    shippingRequired: boolean;
    shippingAddress: Prisma.InputJsonValue | null | undefined;
    shippingCourier: string | null | undefined;
    idempotencyKey: string;
    now: Date;
    productMap: Map<string, { quantity: number; name: string }>;
  },
): Promise<LinkSaleTxResult> {
  const {
    businessId,
    customer,
    resolvedItems,
    grandTotal,
    shippingCost,
    shippingRequired,
    shippingAddress,
    shippingCourier,
    idempotencyKey,
    now,
    productMap,
  } = args;

  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: {
      id: true, name: true, currency: true, cuit: true, address: true,
      ivaCondition: true, puntoVenta: true, iibb: true, activityStart: true,
      taxRate: true, allowNegativeStock: true,
    },
  });
  if (!business) {
    throw Object.assign(new Error("BUSINESS_NOT_FOUND"), { tag: "BUSINESS_NOT_FOUND" });
  }

  // 1. Sale — status="pending" (payment not yet received; MP webhook flips to "paid").
  // [2] MP canonical: external_reference = saleId, pre-existing in seller DB.
  // Tax computed via shared helper — same formula regardless of payment method.
  // Source: https://docs.stripe.com/tax/how-tax-works (VERIFIED HTTP 200)
  const sale = await tx.sale.create({
    data: {
      businessId,
      customerId: customer.id,
      totalAmount: grandTotal,
      taxAmount: computeTaxAmount(grandTotal, business.taxRate).toNumber(),
      status: "pending",
      date: now,
      paymentMethod: "checkout_pro_link",
      shippingRequired,
      shippingQuoteCourier: shippingCourier ?? null,
      shippingQuoteCost: shippingCost > 0 ? shippingCost : null,
      ...(shippingAddress != null ? { shippingAddressId: customer.id } : {}),
    },
  });

  // 2. SaleItems — denormalized for immutability (Stripe line_items pattern [1]).
  await tx.saleItem.createMany({
    data: resolvedItems.map((item) => ({
      saleId: sale.id,
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      unitCost: null,
    })),
  });

  // 3. Inventory decrement (respects allowNegativeStock).
  for (const item of resolvedItems) {
    const stockUpdate = await tx.product.updateMany({
      where: {
        id: item.productId,
        businessId,
        ...(business.allowNegativeStock ? {} : { quantity: { gte: item.quantity } }),
      },
      data: { quantity: { decrement: item.quantity } },
    });
    if (stockUpdate.count !== 1) {
      const snap = productMap.get(item.productId);
      throw Object.assign(new Error("INSUFFICIENT_STOCK"), {
        productName: snap?.name ?? item.productName,
        available: snap?.quantity ?? 0,
      });
    }
  }

  // 4. Invoice (fully-grounded payloadJson — DB rows only, no LLM numbers [4]).
  const hasValidName = typeof business.name === "string" && business.name.trim() !== "";
  const hasValidCuit = typeof business.cuit === "string" && business.cuit.trim() !== "";
  const hasValidIva = typeof business.ivaCondition === "string" && business.ivaCondition.trim() !== "";
  const documentType = hasValidName && hasValidCuit && hasValidIva ? "invoice" : "receipt";
  const sequenceNumber = await nextInvoiceSequenceNumber(tx, businessId, documentType);
  const prefix = documentType === "invoice" ? "FC" : "REC";
  const pv = (business.puntoVenta ?? "0001").padStart(4, "0");
  const invoiceNumber = `${prefix}-${pv}-${String(sequenceNumber).padStart(8, "0")}`;

  const invoicePayload = buildSaleInvoicePayload({
    business,
    resolvedCustomer: customer,
    customerDisplayName: customer.name,
    invoiceNumber,
    saleId: sale.id,
    saleDate: now.toISOString(),
    saleItemsForInvoice: resolvedItems.map((item) => ({
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.lineTotal,
    })),
    serverTotal: grandTotal,
  });

  if (shippingCost > 0 && shippingCourier) {
    invoicePayload.sale.shippingLine = {
      courier: shippingCourier as "andreani" | "oca",
      costARS: shippingCost,
    };
  }

  const invoice = await tx.invoice.create({
    data: {
      businessId,
      saleId: sale.id,
      customerId: customer.id,
      invoiceNumber,
      sequenceNumber,
      documentType,
      issuedAt: now,
      currency: business.currency,
      totalAmount: grandTotal,
      payloadJson: JSON.stringify(invoicePayload),
    },
    select: { id: true },
  });

  // 5. PaymentIntent (pending, checkout_pro_link, bound to Sale).
  // 60-min expiry — same as PAYMENT_INTENT_LINK_EXPIRY_MS in the deprecated
  // payment-intent-link-use-case.ts (H-1 fix: redirect + 3DS can take 5-15 min).
  const LINK_EXPIRY_MS = 60 * 60 * 1000;
  const pi = await tx.paymentIntent.create({
    data: {
      businessId,
      saleId: sale.id,
      monto: grandTotal,
      metodo: "checkout_pro_link",
      estado: "pending",
      expiresAt: new Date(now.getTime() + LINK_EXPIRY_MS),
      matchedCustomerId: customer.id,
      idempotencyKey,
      shippingRequired,
      ...(shippingAddress != null ? { shippingAddress } : {}),
      ...(shippingCost > 0 ? { shippingCostARS: shippingCost } : {}),
    },
    select: { id: true },
  });

  return { sale, invoice, pi };
}
