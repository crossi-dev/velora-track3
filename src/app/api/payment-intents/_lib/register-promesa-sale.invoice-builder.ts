// register-promesa-sale.invoice-builder.ts — Invoice creation for the one-shot
// promesa flow. Split from the use-case to keep both files under 250 LOC.
//
// All values are sourced from DB rows passed in as arguments — no LLM-generated
// numbers reach this function. This satisfies the NABAOS "every monetary value
// must trace to a tool output or DB row" invariant.

import type { Prisma } from "@prisma/client";
import {
  nextInvoiceSequenceNumber,
  buildSaleInvoicePayload,
  type SaleBusinessForInvoice,
  type SaleCustomerForInvoice,
} from "@/infrastructure/shared/sale-invoice";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";
import type { RegisterPromesaSaleShipping } from "./register-promesa-sale-use-case";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ResolvedItem = {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

type BusinessForInvoice = SaleBusinessForInvoice & {
  id: string;
  currency: string;
  taxRate?: number | string | { toNumber(): number } | null;
};

type CustomerForInvoice = SaleCustomerForInvoice;

export interface BuildRegisterPromesaSaleInvoiceArgs {
  business: BusinessForInvoice;
  businessId: string;
  customer: CustomerForInvoice;
  resolvedItems: ResolvedItem[];
  grandTotal: number;
  saleId: string;
  saleDate: Date;
  expectedAt: Date;
  /** Shipping metadata from the owner tool. Null when no freight was included. */
  shipping: RegisterPromesaSaleShipping | null;
}

export interface BuildRegisterPromesaSaleInvoiceResult {
  invoice: {
    id: string;
    saleId: string;
    invoiceNumber: string;
    documentType: string;
    issuedAt: string;
    currency: string;
    totalAmount: number;
    status: string;
  };
  invoicePayload: InvoicePayload;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildRegisterPromesaSaleInvoice(
  tx: Prisma.TransactionClient,
  args: BuildRegisterPromesaSaleInvoiceArgs,
): Promise<BuildRegisterPromesaSaleInvoiceResult> {
  const {
    business,
    businessId,
    customer,
    resolvedItems,
    grandTotal,
    saleId,
    saleDate,
    expectedAt,
    shipping,
  } = args;

  const hasValidName = typeof business.name === "string" && business.name.trim() !== "";
  const hasValidCuit = typeof business.cuit === "string" && business.cuit.trim() !== "";
  const hasValidIva =
    typeof business.ivaCondition === "string" && business.ivaCondition.trim() !== "";
  const documentType =
    hasValidName && hasValidCuit && hasValidIva ? "invoice" : "receipt";

  const sequenceNumber = await nextInvoiceSequenceNumber(tx, businessId, documentType);
  const prefix = documentType === "invoice" ? "FC" : "REC";
  const pv = (business.puntoVenta ?? "0001").padStart(4, "0");
  const invoiceNumber = `${prefix}-${pv}-${String(sequenceNumber).padStart(8, "0")}`;
  const issuedAt = new Date();

  // Build invoice line items from DB-resolved values only.
  const saleItemsForInvoice: InvoicePayload["sale"]["items"] = resolvedItems.map((item) => ({
    productName: item.productName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    subtotal: item.lineTotal,
  }));

  // Include promesa note as a sale-level annotation in invoiceNumber suffix
  // so the PDF renderer can display it. The actual note lives in PaymentIntent.description.
  const expectedDateStr = expectedAt.toISOString().slice(0, 10);

  const invoicePayload: InvoicePayload = buildSaleInvoicePayload({
    business,
    resolvedCustomer: customer,
    customerDisplayName: customer.name,
    invoiceNumber,
    saleId,
    saleDate: saleDate.toISOString(),
    saleItemsForInvoice,
    serverTotal: grandTotal,
  });

  // Annotate the payload with a promesa note so the PDF footer reflects the
  // deferred-payment nature. InvoicePayload.sale is typed as a plain object;
  // we extend it safely here — the PDF renderer ignores unknown fields.
  const saleExtension = invoicePayload.sale as Record<string, unknown>;
  saleExtension["promesaNote"] = `Promesa de pago — vence ${expectedDateStr}`;

  // shippingLine — assigned directly to the typed field (InvoicePayload.sale.shippingLine).
  // grandTotal in the payload already includes shipping (passed from use-case); the
  // PDF renderer adds shippingLine as a distinct line item above the total.
  // Cost value is DB-grounded (input.shipping.cost from tool schema, not LLM text).
  if (shipping) {
    invoicePayload.sale.shippingLine = { courier: shipping.courier, costARS: shipping.cost };
    // Note: saleExtension["grandTotal"] override removed — the totals renderer reads
    // payload.sale.total which buildSaleInvoicePayload already set to serverTotal (grandTotal).
  }

  const createdInvoice = await tx.invoice.create({
    data: {
      businessId,
      saleId,
      customerId: customer.id,
      invoiceNumber,
      sequenceNumber,
      documentType,
      issuedAt,
      currency: business.currency,
      totalAmount: grandTotal,
      payloadJson: JSON.stringify(invoicePayload),
    },
    select: { id: true },
  });

  return {
    invoice: {
      id: createdInvoice.id,
      saleId,
      invoiceNumber,
      documentType,
      issuedAt: issuedAt.toISOString(),
      currency: business.currency,
      totalAmount: grandTotal,
      status: "issued",
    },
    invoicePayload,
  };
}
