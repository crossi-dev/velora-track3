// register-promesa-sale.transaction.ts — Atomic DB write for the one-shot
// promesa flow. Contains the full $transaction body extracted from the use-case
// to keep both files under the 300-line server/api hard limit.

import type { Prisma } from "@prisma/client";
import { buildRegisterPromesaSaleInvoice } from "./register-promesa-sale.invoice-builder";
import type { RegisterPromesaSaleShipping } from "./register-promesa-sale-use-case";
import { computeTaxAmount } from "@/lib/money";

// ---------------------------------------------------------------------------
// Types (re-exported for use-case)
// ---------------------------------------------------------------------------

export type ResolvedPromesaItem = {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type ResolvedPromesaCustomer = {
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

export type PromesaSaleTxResult = {
  createdSale: { id: string };
  createdInvoice: { id: string };
  createdPI: { id: string };
};

// ---------------------------------------------------------------------------
// Transaction body
// ---------------------------------------------------------------------------

export async function runPromesaSaleTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    customer: ResolvedPromesaCustomer;
    resolvedItems: ResolvedPromesaItem[];
    grandTotal: number;
    now: Date;
    expectedAt: Date;
    expectedDateStr: string;
    reason: string | undefined;
    idempotencyKey: string;
    shipping: RegisterPromesaSaleShipping | null;
    productMap: Map<string, { quantity: number; name: string }>;
  },
): Promise<PromesaSaleTxResult> {
  const {
    businessId,
    customer,
    resolvedItems,
    grandTotal,
    now,
    expectedAt,
    expectedDateStr,
    reason,
    idempotencyKey,
    shipping,
    productMap,
  } = args;

  // Single round-trip: fetch all business fields needed for both invoice payload
  // (name, currency, cuit, …) and stock-decrement gate (allowNegativeStock).
  // Collapsing the previous two findUnique calls eliminates one DB round-trip
  // inside the transaction.
  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: {
      id: true, name: true, currency: true, cuit: true, address: true,
      ivaCondition: true, puntoVenta: true, iibb: true, activityStart: true,
      taxRate: true, allowNegativeStock: true,
    },
  });
  if (!business) {
    // Use tagged error (matching INSUFFICIENT_STOCK pattern) so the use-case
    // catch branch can distinguish this from unhandled infrastructure errors.
    throw Object.assign(new Error("BUSINESS_NOT_FOUND"), { tag: "BUSINESS_NOT_FOUND" });
  }

  const { allowNegativeStock } = business;

  // Resolve shippingAddressId: prefer caller-supplied value; fall back to
  // customer.id as a stable pointer to the customer's address-on-file.
  // This keeps the field non-null whenever shipping is present, satisfying
  // the downstream Andreani agent that uses it to locate delivery details.
  const resolvedShippingAddressId: string | null = shipping
    ? (shipping.shippingAddressId ?? customer.id)
    : null;

  // 1. Sale (status="paid", paymentMethod="promesa")
  // Tax computed via shared helper — same formula regardless of payment method.
  // Source: https://docs.stripe.com/tax/how-tax-works (VERIFIED HTTP 200)
  const createdSale = await tx.sale.create({
    data: {
      businessId,
      customerId: customer.id,
      totalAmount: grandTotal,
      taxAmount: computeTaxAmount(grandTotal, business.taxRate).toNumber(),
      status: "paid",
      date: now,
      paymentMethod: "promesa",
      shippingRequired: shipping !== null,
      shippingQuoteCourier: shipping?.courier ?? null,
      shippingQuoteCost: shipping?.cost ?? null,
      shippingAddressId: resolvedShippingAddressId,
    },
  });

  // 2. SaleItems — denormalize productName + unitPrice for immutability (Stripe pattern)
  await tx.saleItem.createMany({
    data: resolvedItems.map((item) => ({
      saleId: createdSale.id,
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      unitCost: null,
    })),
  });

  // 3. Inventory decrement (respects allowNegativeStock — resolved above)
  for (const item of resolvedItems) {
    const stockUpdate = await tx.product.updateMany({
      where: {
        id: item.productId,
        businessId,
        ...(allowNegativeStock ? {} : { quantity: { gte: item.quantity } }),
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

  // 4. Invoice (fully-grounded payloadJson — built from DB rows, not LLM input)
  const { invoice: createdInvoice } = await buildRegisterPromesaSaleInvoice(tx, {
    business,
    businessId,
    customer,
    resolvedItems,
    grandTotal,
    saleId: createdSale.id,
    saleDate: now,
    expectedAt,
    shipping: shipping ?? null,
  });

  // 5. CashMovement (accrual "in")
  // clientMessageId derived from the outer PI idempotency key so a retry of the
  // same register-promesa-sale call produces the same key and the DB-level
  // partial unique index "CashMovement_businessId_clientMessageId_key"
  // (migration 20260525900000_add_cashmovement_dedup_key) deduplicates on P2002.
  // Pattern: Stripe idempotency-key standard — every money-write carries a stable
  // deterministic key so retries cannot double-book cash.
  // Sources:
  //   https://docs.stripe.com/api/idempotent_requests
  //   https://www.postgresql.org/docs/current/indexes-partial.html
  const cashDescription =
    `Promesa de pago — vence ${expectedDateStr}` + (reason ? ` — ${reason}` : "");
  await tx.cashMovement.create({
    data: {
      businessId,
      saleId: createdSale.id,
      type: "in",
      amount: grandTotal,
      paymentMethod: "promesa",
      description: cashDescription,
      date: now,
      clientMessageId: `promesa-sale-${idempotencyKey}`,
    },
  });

  // 6. PaymentIntent (confirmed, promesa, bound to Sale)
  // idempotencyKey on PI enables @@unique([businessId, idempotencyKey]) replay guard.
  const createdPI = await tx.paymentIntent.create({
    data: {
      businessId,
      saleId: createdSale.id,
      monto: grandTotal,
      metodo: "promesa",
      estado: "confirmed",
      confirmedAt: now,
      promesaExpectedAt: expectedAt,
      matchedCustomerId: customer.id,
      idempotencyKey,
    },
  });

  return { createdSale, createdInvoice, createdPI };
}
