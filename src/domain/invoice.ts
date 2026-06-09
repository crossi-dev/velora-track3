// Core domain types — no UI, no framework dependencies

export type InvoiceType = "receipt" | "invoice";
export type InvoiceStatus = "issued" | "sent" | "paid";

export interface Invoice {
  id: string;
  businessId: string;
  saleId: string;
  customerId: string | null;
  number: string;
  sequenceNumber: number;
  type: InvoiceType;
  currency: string;
  totalAmount: number;
  status: InvoiceStatus;
  issuedAt: string;
  sentAt: string | null;
  sentTo: string | null;
}
