export interface RawSaleEntry {
  customerName?: string;
  items: { productName: string; quantity: number; unitPrice?: number | string }[];
}

export const MAX_PARSED_SALES = 25;
export const MAX_ITEMS_PER_PARSED_SALE = 50;
export const MAX_TOTAL_PARSED_ITEMS = 200;

export const FALLBACK_CUSTOMER_NAME = "Consumidor Final";
