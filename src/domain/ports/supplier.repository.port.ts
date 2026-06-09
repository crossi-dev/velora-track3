import type { Tx } from "./tx";

export interface SupplierRecord {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  contactName: string | null;
  leadTimeDays: number;
}

export interface SupplierCreateArgs {
  businessId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  leadTimeDays?: number | null;
}

export interface SupplierUpdateArgs {
  businessId: string;
  supplierId: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  leadTimeDays?: number | null;
}

export interface SupplierDeleteArgs {
  businessId: string;
  supplierId: string;
  snapshot: { name: string; phone: string | null; email: string | null; contactName: string | null };
}

export interface SupplierRepositoryPort {
  findById(businessId: string, supplierId: string): Promise<SupplierRecord | null>;
  createInTransaction(tx: Tx, args: SupplierCreateArgs): Promise<SupplierRecord>;
  updateInTransaction(tx: Tx, args: SupplierUpdateArgs): Promise<void>;
  deleteInTransaction(tx: Tx, args: SupplierDeleteArgs): Promise<void>;
}
