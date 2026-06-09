import type { Tx } from "./tx";

export interface ResolvedProductRecord {
  id: string;
  name: string;
  price: number;
  costPrice: number | null;
  sku: string | null;
}

export type ResolveOrCreateOutcome =
  | { outcome: "resolved" | "created"; product: ResolvedProductRecord }
  | { outcome: "sku_collision" };

export interface ProductRecord {
  id: string;
  name: string;
  price: number;
  costPrice: number | null;
  sku: string | null;
  /** Weight in grams. Null when not set. */
  weightGrams?: number | null;
  stock: number;
}

export interface ProductForDelete {
  id: string;
  name: string;
  price: number;
  costPrice: number | null;
  sku: string | null;
  stock: number;
  saleItemsCount: number;
  stockMovementsCount: number;
}

export interface ProductCreateArgs {
  businessId: string;
  name: string;
  price: number;
  costPrice: number | null;
  /** Weight in grams. Null when not provided. */
  weightGrams?: number | null;
  initialStock: number;
  stockReason: string;
  stockReferenceId: string | null;
}

export interface ProductUpdateArgs {
  businessId: string;
  productId: string;
  name?: string;
  price?: number;
  costPrice?: number | null;
  sku?: string | null;
  /** Weight in grams. Null explicitly clears. Undefined = no change. */
  weightGrams?: number | null;
  stockQuantity?: number;
  stockReason: string;
  stockReferenceId: string | null;
}

export interface BulkPriceProduct {
  id: string;
  name: string;
  price: number;
}

export interface ProductRepositoryPort {
  findForDelete(businessId: string, productId: string): Promise<ProductForDelete | null>;
  createWithSkuRetry(
    args: ProductCreateArgs,
    onCreated: (tx: Tx, product: ProductRecord) => Promise<void>
  ): Promise<ProductRecord>;
  updateInTransaction(tx: Tx, args: ProductUpdateArgs): Promise<{ productId: string; productName: string; updatedSku?: string | null }>;
  deleteInTransaction(tx: Tx, args: { businessId: string; productId: string }): Promise<{ archived: boolean }>;
  fetchForBulkPriceUpdate(businessId: string, productIds: string[]): Promise<BulkPriceProduct[]>;
  bulkUpdatePricesInTransaction(tx: Tx, businessId: string, updates: Array<{ id: string; newPrice: number }>): Promise<void>;
  fetchNamesForAudit(businessId: string, productIds: string[]): Promise<Array<{ id: string; name: string }>>;
  resolveOrCreateWithSkuRetry(
    businessId: string,
    args: { name: string; price: number; costPrice?: number | null },
    normalizedName: string,
    onCreated: (tx: Tx, product: ResolvedProductRecord) => Promise<void>
  ): Promise<ResolveOrCreateOutcome>;
}
