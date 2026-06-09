import type { NextResponse } from "next/server";

export type UndoTarget =
  | "sale"
  | "customer"
  | "stock"
  | "product"
  | "supplier"
  | "cash-movement"
  | "product-create";

export type UndoHandlerContext = {
  businessId: string;
  userId: string;
  safeCount: number;
  anchoredStockIds: string[];
  productId?: string;
  idempotencyRecordId: string;
  routeScope: string;
  undoCutoff: Date;
  releaseAndReturnError: (body: Record<string, unknown>, status: number) => Promise<NextResponse>;
};
