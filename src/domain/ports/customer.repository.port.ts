import type { Tx } from "./tx";

export interface CustomerRecord {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  taxId: string | null;
  dni: string | null;
  ivaCondition: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}

export interface CustomerCreateArgs {
  businessId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
  dni?: string | null;
  ivaCondition?: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
}

export interface CustomerUpdateArgs {
  businessId: string;
  customerId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
  dni?: string | null;
  ivaCondition?: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
}

export interface CustomerDeleteArgs {
  businessId: string;
  customerId: string;
  snapshot: { name: string; phone: string | null; email: string | null; taxId: string | null };
}

export interface CustomerRepositoryPort {
  findById(businessId: string, customerId: string): Promise<CustomerRecord | null>;
  findByName(businessId: string, name: string): Promise<{ id: string } | null>;
  hasHistory(businessId: string, customerId: string): Promise<{ invoiceCount: number; saleCount: number }>;
  createInTransaction(tx: Tx, args: CustomerCreateArgs): Promise<CustomerRecord>;
  updateInTransaction(tx: Tx, args: CustomerUpdateArgs): Promise<CustomerRecord>;
  deleteInTransaction(tx: Tx, args: CustomerDeleteArgs): Promise<void>;
}
