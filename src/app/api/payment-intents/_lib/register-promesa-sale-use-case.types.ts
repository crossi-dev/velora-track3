// Public types for register-promesa-sale-use-case — extracted to keep the
// use-case file within the 300-line size contract. Re-exported from the
// use-case module so existing importers keep their import path.

export interface RegisterPromesaSaleItem {
  productId: string;
  quantity: number;
  /** When absent, product.price from DB is used. */
  unitPriceOverride?: number;
}

export interface RegisterPromesaSaleShipping {
  courier: "andreani" | "oca";
  cost: number;
  shippingAddressId?: string | null;
}

export interface RegisterPromesaSaleInput {
  businessId: string;
  actorUserId: string;
  customerId: string;
  items: RegisterPromesaSaleItem[];
  expectedAt: Date;
  reason?: string;
  shipping?: RegisterPromesaSaleShipping;
}

export type RegisterPromesaSaleResult =
  | { outcome: "created"; paymentIntentId: string; saleId: string; grandTotal: number }
  | { outcome: "replayed"; paymentIntentId: string; saleId: string }
  | { outcome: "business_not_found" }
  | { outcome: "customer_not_found" }
  | { outcome: "product_not_found"; productId: string }
  | { outcome: "wrong_business"; productId: string }
  | { outcome: "invalid_qty"; productId: string }
  | { outcome: "unit_price_out_of_range"; productId: string }
  | { outcome: "insufficient_stock"; productName: string; available: number }
  | { outcome: "invalid_total" };
