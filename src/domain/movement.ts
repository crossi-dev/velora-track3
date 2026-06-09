// Core domain types — no UI, no framework dependencies

/** Discriminates income, expense, and sale-linked cash flows. */
export type MovementType = "income" | "expense" | "sale" | string;

export interface CashMovement {
  id: string;
  type: MovementType;
  /** Linked sale ID when type === "sale". */
  saleId?: string | null;
  description: string;
  amount: number;
  date: string;
}
