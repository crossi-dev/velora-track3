import type { Prisma } from "@prisma/client";
import { computeTaxAmount } from "@/lib/money";
import { createCashMovementInTransaction } from "@/infrastructure/shared/cash-mutations";
import { BusinessNotFoundError } from "@/domain/errors";
import { resolveSaleCustomerInTransaction, normalizeCustomerName } from "@/infrastructure/shared/sale-customer";
import { processCheckedItemsInTransaction, type CheckedItem } from "@/infrastructure/shared/sale-inventory";
import { nextInvoiceSequenceNumber, buildSaleInvoicePayload, type InvoicePayload, type SaleBusinessForInvoice, type SaleCustomerForInvoice } from "@/infrastructure/shared/sale-invoice";
type InvoiceResult = {
  id: string;
  saleId: string;
  invoiceNumber: string;
  documentType: string;
  issuedAt: string;
  currency: string;
  totalAmount: number;
  status: string;
  payload: InvoicePayload;
};

export type SaleTransactionResult = {
  sale: { id: string; totalAmount: number | { toNumber(): number }; status: string; date: Date };
  invoice: InvoiceResult;
  lowStockAlerts: Array<{ productId: string; productName: string; remainingUnits: number; reorderThreshold: number }>;
  whatsappPhone: string | null;
  notifyLowStockWa: boolean;
  auditMeta: {
    invoiceId: string;
    invoiceNumber: string;
    customerId: string;
    customerName: string;
    totalAmount: number;
    itemCount: number;
  };
  idempotencyResponseBody: {
    sale: { id: string; totalAmount: number | { toNumber(): number }; status: string };
    invoice: InvoiceResult;
  };
};

export async function runSaleTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    customerId?: string | null;
    employeeId?: string | null;
    fallbackCustomerName: string;
    normalizedFallbackCustomerName: string;
    checkedItems: CheckedItem[];
    serverTotal: number;
    allowNegativeStock: boolean;
    // Payment method for cash-register breakdown. Defaults to "efectivo".
    paymentMethod?: string | null;
  }
): Promise<SaleTransactionResult> {
  const {
    businessId,
    customerId,
    employeeId = null,
    fallbackCustomerName,
    normalizedFallbackCustomerName,
    checkedItems,
    serverTotal,
    allowNegativeStock,
    paymentMethod = "efectivo",
  } = args;

  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      currency: true,
      cuit: true,
      address: true,
      whatsappPhone: true,
      notifyLowStockWa: true,
      ivaCondition: true,
      puntoVenta: true,
      iibb: true,
      activityStart: true,
      taxRate: true,
    },
  });

  if (!business) {
    throw new BusinessNotFoundError();
  }

  const resolvedCustomer = await resolveSaleCustomerInTransaction(tx, {
    businessId,
    customerId,
    fallbackCustomerName,
    normalizedFallbackCustomerName,
  });

  const customerDisplayName = normalizeCustomerName(resolvedCustomer.name);

  // Compute tax via the shared helper — single formula for all sale paths.
  // Source: https://docs.stripe.com/tax/how-tax-works (VERIFIED HTTP 200)
  // e.g. serverTotal=1000, taxRate=21 → 210.00 ✓
  const taxAmount = computeTaxAmount(serverTotal, business.taxRate).toNumber();

  // Async payment methods (qr, transferencia) are pending until the provider
  // webhook or manual owner confirmation arrives. Sync methods (efectivo,
  // tarjeta, null) are paid immediately — money is in hand at sale time.
  const ASYNC_PAYMENT_METHODS = new Set(["qr", "transferencia"]);
  const isAsyncPayment =
    typeof paymentMethod === "string" && ASYNC_PAYMENT_METHODS.has(paymentMethod);
  const saleStatus = isAsyncPayment ? "pending" : "paid";

  const createdSale = await tx.sale.create({
    data: {
      businessId,
      customerId: resolvedCustomer.id,
      employeeId: employeeId ?? null,
      totalAmount: serverTotal,
      taxAmount,
      status: saleStatus,
      date: new Date(),
      paymentMethod,
    },
  });

  const { saleItemsForInvoice, lowStockAlerts } = await processCheckedItemsInTransaction(tx, {
    checkedItems,
    saleId: createdSale.id,
    businessId,
    allowNegativeStock,
  });

  // CashMovement is written immediately only for sync payment methods.
  // For async methods (qr, transferencia) the confirm-transaction path writes
  // the CashMovement when the PaymentIntent transitions to "confirmed", after
  // the provider webhook or manual owner confirmation.
  if (!isAsyncPayment) {
    const description = customerDisplayName
      ? `Venta a ${customerDisplayName}`
      : "Venta registrada";
    await createCashMovementInTransaction(tx, {
      businessId,
      saleId: createdSale.id,
      type: "sale",
      description,
      amount: serverTotal,
      paymentMethod,
      // Explicit idempotency token. The saleId-based partial unique index
      // (CashMovement_saleId_cash_key, migration 20260519320000) is the primary
      // DB-level dedup guard; clientMessageId adds an explicit audit token so
      // the row is queryable by key without a saleId join.
      clientMessageId: `sale-${createdSale.id}`,
    });
  }

  const invoiceResult = await createSaleInvoiceInTx(tx, {
    business,
    businessId,
    resolvedCustomer,
    customerDisplayName,
    saleId: createdSale.id,
    saleDate: createdSale.date,
    saleItemsForInvoice,
    serverTotal,
  });

  return {
    sale: createdSale,
    invoice: invoiceResult,
    lowStockAlerts,
    whatsappPhone: business.whatsappPhone,
    notifyLowStockWa: business.notifyLowStockWa,
    auditMeta: {
      invoiceId: invoiceResult.id,
      invoiceNumber: invoiceResult.invoiceNumber,
      customerId: resolvedCustomer.id,
      customerName: resolvedCustomer.name,
      totalAmount: serverTotal,
      itemCount: checkedItems.length,
    },
    idempotencyResponseBody: {
      sale: {
        id: createdSale.id,
        totalAmount: Number(createdSale.totalAmount),
        status: createdSale.status,
      },
      invoice: invoiceResult,
    },
  };
}

async function createSaleInvoiceInTx(
  tx: Prisma.TransactionClient,
  args: {
    business: SaleBusinessForInvoice;
    businessId: string;
    resolvedCustomer: SaleCustomerForInvoice;
    customerDisplayName: string;
    saleId: string;
    saleDate: Date;
    saleItemsForInvoice: InvoicePayload["sale"]["items"];
    serverTotal: number;
  }
): Promise<InvoiceResult> {
  const { business, businessId, resolvedCustomer, customerDisplayName, saleId, saleDate, saleItemsForInvoice, serverTotal } = args;

  const hasValidName = typeof business.name === "string" && business.name.trim() !== "";
  const hasValidCuit = typeof business.cuit === "string" && business.cuit.trim() !== "";
  const hasValidIva = typeof business.ivaCondition === "string" && business.ivaCondition.trim() !== "";
  const documentType = hasValidName && hasValidCuit && hasValidIva ? "invoice" : "receipt";

  const sequenceNumber = await nextInvoiceSequenceNumber(tx, businessId, documentType);
  const prefix = documentType === "invoice" ? "FC" : "REC";
  const pv = (business.puntoVenta ?? "0001").padStart(4, "0");
  const invoiceNumber = `${prefix}-${pv}-${String(sequenceNumber).padStart(8, "0")}`;
  const issuedAt = new Date();

  const invoicePayload: InvoicePayload = buildSaleInvoicePayload({
    business,
    resolvedCustomer,
    customerDisplayName,
    invoiceNumber,
    saleId,
    saleDate: saleDate.toISOString(),
    saleItemsForInvoice,
    serverTotal,
  });

  const createdInvoice = await tx.invoice.create({
    data: {
      businessId,
      saleId,
      customerId: resolvedCustomer.id,
      invoiceNumber,
      sequenceNumber,
      documentType,
      issuedAt,
      currency: business.currency,
      totalAmount: serverTotal,
      payloadJson: JSON.stringify(invoicePayload),
    },
  });

  return {
    id: createdInvoice.id,
    saleId,
    invoiceNumber,
    documentType,
    issuedAt: issuedAt.toISOString(),
    currency: business.currency,
    totalAmount: serverTotal,
    status: "issued",
    payload: invoicePayload,
  };
}
