import type { Tx } from "./tx";

export interface InventoryRecord {
  productId: string;
  quantity: number;
  product: {
    name: string;
    businessId: string;
    costPrice: number | null;
    price: number;
  };
}

export interface InventoryRepositoryPort {
  loadForProducts(tx: Tx, productIds: string[], businessId: string): Promise<InventoryRecord[]>;
}
