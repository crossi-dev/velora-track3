import type { Tx } from "./tx";

export interface PurchaseRequestCreateArgs {
  businessId: string;
  supplierId: string | null;
  supplierName: string | null;
  itemName: string;
  quantity: number;
  unitPrice: number;
}

export interface PurchaseRequestRecord {
  id: string;
  requestNumber: string;
  issuedAt: string;
  currency: string;
  totalAmount: number;
  payload: unknown;
}

export interface PurchaseRequestAuditMeta {
  requestId: string;
  requestNumber: string;
  supplierId: string;
  supplierName: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
}

export interface PurchaseRequestListRecord {
  id: string;
  requestNumber: string;
  issuedAt: Date;
  currency: string;
  totalAmount: number;
  supplierId: string | null;
}

export interface PurchaseRequestRepositoryPort {
  list(businessId: string): Promise<PurchaseRequestListRecord[]>;
  createInTransaction(
    tx: Tx,
    args: PurchaseRequestCreateArgs
  ): Promise<{ request: PurchaseRequestRecord; auditMeta: PurchaseRequestAuditMeta }>;
}
