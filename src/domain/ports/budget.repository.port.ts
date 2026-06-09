import type { Tx } from "./tx";

export interface BudgetItemRecord {
  id: string;
  productId: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface BudgetRecord {
  id: string;
  budgetNumber: string;
  customerName: string | null;
  customerId: string | null;
  note: string | null;
  currency: string;
  totalAmount: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  items: BudgetItemRecord[];
}

export interface CreateBudgetArgs {
  businessId: string;
  currency: string;
  customerName: string | null;
  customerId: string | null;
  note: string | null;
  totalAmount: number;
  items: Array<{ productId: string | null; name: string; quantity: number; unitPrice: number }>;
}

export interface BudgetRepositoryPort {
  findById(businessId: string, budgetId: string): Promise<{ id: string } | null>;
  list(businessId: string): Promise<BudgetRecord[]>;
  createInTransaction(tx: Tx, args: CreateBudgetArgs): Promise<BudgetRecord>;
  deleteInTransaction(tx: Tx, budgetId: string, businessId: string): Promise<void>;
}
