import type { Tx } from "./tx";

// "withdrawal" = sangría / retiro de efectivo de caja (distinct from "adjustment").
// Added 2026-06-03: "retiro" previously mapped to "adjustment", corrupting caja reports.
// Square equivalent: CashDrawerShiftEvent PAID_OUT; Toast equivalent: PAY_OUT.
export type CashMovementType = "purchase" | "tax" | "salary" | "adjustment" | "income" | "sale" | "withdrawal";

export interface CreateCashMovementArgs {
  businessId: string;
  type: CashMovementType;
  description: string;
  amount: number;
  saleId?: string | null;
  date: Date;
  // Client-supplied idempotency key. Persisted to enable DB-level dedup via the partial
  // unique index CashMovement_businessId_clientMessageId_key. Null for sale-linked movements.
  clientMessageId?: string | null;
}

export interface CashMovementRecord {
  id: string;
  type: string;
  description: string;
  amount: number;
  date: Date;
  saleId: string | null;
  clientMessageId?: string | null;
}

export interface CashMovementRepositoryPort {
  createInTransaction(tx: Tx, args: CreateCashMovementArgs): Promise<CashMovementRecord>;
}
