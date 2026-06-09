export interface SaleItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateSaleBody {
  businessId: string;
  customerId?: string;
  items: SaleItem[];
  total: number;
  locale?: string;
}

/**
 * Validación de shape de cada item: productId no vacío, quantity entera > 0,
 * unitPrice > 0. Devuelve null si todos válidos, mensaje si alguno falla.
 */
export function validateItemShapes(items: SaleItem[]): string | null {
  for (const item of items) {
    if (
      !item ||
      typeof item.productId !== "string" ||
      !item.productId.trim() ||
      !Number.isFinite(item.quantity) ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0 ||
      !Number.isFinite(item.unitPrice) ||
      item.unitPrice <= 0
    ) {
      return "Cada ítem debe incluir un producto válido, cantidad positiva y precio unitario mayor a cero.";
    }
  }
  return null;
}
