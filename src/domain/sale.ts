// Core domain types — no UI, no framework dependencies

export interface SaleItem {
  quantity: number;
  unitPrice: number;
  unitCost?: number | null;
  product: { id: string; name: string };
}

// Every sale is pay-in-full. Status is always "paid".
export type SaleStatus = "paid";

export interface Sale {
  id: string;
  date: string;
  totalAmount: number;
  status?: SaleStatus | string;
  customer: { id: string; name: string } | null;
  items: SaleItem[];
}

export interface ParsedSaleItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  invalidProduct?: boolean;
  priceOutlier?: { expected: number; direction: "above" | "below" };
  stockShortfall?: { available: number; requested: number };
}

// Canonical payment method values — single source of truth.
// sale-schema.ts and AssistantSalePaymentMethod.tsx derive from here.
export const PAYMENT_METHOD_VALUES = [
  "efectivo",
  "qr",
  "transferencia",
  "tarjeta",
] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHOD_VALUES)[number];

export interface ParsedSale {
  customer: { id: string; name: string };
  items: ParsedSaleItem[];
  total: number;
  // Payment method selected in the sale draft confirmation UI.
  // Defaults to "efectivo" when absent (backwards-compatible with existing drafts).
  paymentMethod?: PaymentMethodValue;
}
