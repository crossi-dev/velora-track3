import type { Tx } from "./tx";

export interface SaleSummary {
  id: string;
  totalAmount: number;
}

export interface CheckedSaleItem {
  productId: string;
  quantity: number;
  unitPrice: number;
  productName: string;
  unitCost: number | null;
}

export interface LowStockAlert {
  productId: string;
  productName: string;
  remainingUnits: number;
  reorderThreshold: number;
}

export interface InvoiceResult {
  id: string;
  saleId: string;
  invoiceNumber: string;
  documentType: string;
  issuedAt: string;
  currency: string;
  totalAmount: number;
  status: string;
  payload: unknown;
}

export interface CreateSaleTransactionArgs {
  businessId: string;
  customerId: string | null;
  employeeId: string | null;
  fallbackCustomerName: string;
  normalizedFallbackCustomerName: string;
  checkedItems: CheckedSaleItem[];
  serverTotal: number;
  allowNegativeStock: boolean;
  // Payment method for the sale. Defaults to "efectivo" at the use-case boundary.
  paymentMethod: string;
}

export interface CreateSaleTransactionResult {
  sale: { id: string; totalAmount: number; status: string; date: Date };
  invoice: InvoiceResult;
  lowStockAlerts: LowStockAlert[];
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
    sale: { id: string; totalAmount: number; status: string };
    invoice: InvoiceResult;
  };
}

export interface SaleRepositoryPort {
  checkEntitiesExist(businessId: string, productIds: string[], customerId: string | null): Promise<string[]>;
  createTransaction(tx: Tx, args: CreateSaleTransactionArgs): Promise<CreateSaleTransactionResult>;
}
