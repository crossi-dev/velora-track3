// Core domain types — no UI, no framework dependencies

export type PurchaseRequestStatus = "pending" | "approved" | "sent" | "cancelled";

export interface PurchaseRequestItem {
  productId: string;
  productName: string;
  quantity: number;
}

export interface PurchaseRequest {
  id: string;
  businessId: string;
  supplierId: string | null;
  status: PurchaseRequestStatus;
  items: PurchaseRequestItem[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
