import type { Prisma } from "@prisma/client";
import { buildInvoicePayload, splitCustomerName, type InvoicePayload } from "@/infrastructure/shared/invoice-document";
import { nextBusinessCounter } from "@/infrastructure/shared/business-counter";

export type InvoiceSequenceClient = {
  businessCounter: {
    upsert: Prisma.TransactionClient["businessCounter"]["upsert"];
  };
  invoice: {
    findFirst: Prisma.TransactionClient["invoice"]["findFirst"];
  };
};

export async function nextInvoiceSequenceNumber(
  tx: InvoiceSequenceClient,
  businessId: string,
  documentType: "invoice" | "receipt"
) {
  const counterType = `invoice:${documentType}`;
  const counterValue = await nextBusinessCounter(tx, businessId, counterType);

  if (Number.isFinite(counterValue) && counterValue > 0) {
    return counterValue;
  }

  const previousInvoice = await tx.invoice.findFirst({
    where: { businessId, documentType },
    orderBy: { sequenceNumber: "desc" },
    select: { sequenceNumber: true },
  });

  const fallbackValue = Math.max(1, Number(previousInvoice?.sequenceNumber ?? 0) + 1);

  // Persist the computed fallback value so subsequent callers advance from
  // this baseline. Use `set` (not `increment`) — if the row exists with value=0
  // (the trigger for this branch), increment would produce 2 but return
  // fallbackValue, causing the counter to drift behind reality.
  // Duplicate invoice numbers from a concurrent fallback race are prevented by
  // the existing @@unique([businessId, invoiceNumber]) constraint on Invoice,
  // which is the correct second-line defense.
  await tx.businessCounter.upsert({
    where: {
      businessId_counterType: { businessId, counterType },
    },
    update: { value: { set: fallbackValue } },
    create: {
      id: crypto.randomUUID().replace(/-/g, ""),
      businessId,
      counterType,
      value: fallbackValue,
    },
    select: { value: true },
  });

  return fallbackValue;
}

export type SaleBusinessForInvoice = {
  name: string;
  currency: string;
  cuit: string | null;
  address: string | null;
  ivaCondition: string | null;
  puntoVenta: string | null;
  iibb: string | null;
  activityStart: Date | string | null;
  taxRate?: number | string | { toNumber(): number } | null;
};

export type SaleCustomerForInvoice = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  dni?: string | null;
  address?: string | null;
  postalCode?: string | null;
};

export function buildSaleInvoicePayload(args: {
  business: SaleBusinessForInvoice;
  resolvedCustomer: SaleCustomerForInvoice;
  customerDisplayName: string;
  invoiceNumber: string;
  saleId: string;
  saleDate: string;
  saleItemsForInvoice: InvoicePayload["sale"]["items"];
  serverTotal: number;
}): InvoicePayload {
  const { business, resolvedCustomer, customerDisplayName, invoiceNumber, saleId, saleDate, saleItemsForInvoice, serverTotal } = args;
  const customerNameParts = splitCustomerName(customerDisplayName || resolvedCustomer.name);
  const rawTaxRate = business.taxRate != null
    ? (typeof business.taxRate === "object" && "toNumber" in business.taxRate
      ? business.taxRate.toNumber()
      : Number(business.taxRate))
    : null;
  const normalizedTaxRate = rawTaxRate != null && Number.isFinite(rawTaxRate) && rawTaxRate > 0
    ? rawTaxRate
    : null;

  return buildInvoicePayload({
    business: {
      name: business.name,
      cuit: business.cuit ?? null,
      address: business.address ?? null,
      currency: business.currency,
      ivaCondition: business.ivaCondition ?? null,
      puntoVenta: business.puntoVenta ?? null,
      iibb: business.iibb ?? null,
      activityStart: business.activityStart instanceof Date ? business.activityStart.toISOString() : (business.activityStart ?? null),
      taxRate: normalizedTaxRate,
    },
    customer: {
      name: customerDisplayName || resolvedCustomer.name,
      firstName: customerNameParts.firstName || null,
      lastName: customerNameParts.lastName || null,
      taxId: resolvedCustomer.taxId ?? null,
      email: resolvedCustomer.email ?? null,
      phone: resolvedCustomer.phone ?? null,
      dni: resolvedCustomer.dni ?? null,
      address: resolvedCustomer.address ?? null,
      postalCode: resolvedCustomer.postalCode ?? null,
    },
    sale: {
      id: saleId,
      invoiceNumber,
      date: saleDate,
      items: saleItemsForInvoice,
      total: serverTotal,
    },
  });
}

export type { InvoicePayload };
