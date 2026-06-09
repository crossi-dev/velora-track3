"use client";

export type PendingSaleMissingField = "quantity" | "price" | "customer";

export interface PendingSaleFlow {
  saleText: string;
  missingField: PendingSaleMissingField;
  answer: string;
  inputHint: string | null;
  priceProductId?: string | null;
  priceProductName?: string | null;
  customerOptions?: Array<{ id: string; name: string }> | null;
}

export interface RecoverPendingSaleFlowOptions {
  saleText?: string | null;
  questionContext?: string | null;
  answer?: string | null;
  inputHint?: string | null;
  parseMissingField?: { productId: string; productName: string } | null;
  customerSelectContext?: { saleText: string; clients: Array<{ id: string; name: string }> } | null;
}
