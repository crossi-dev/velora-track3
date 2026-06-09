import type { Prisma } from "@prisma/client";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";
import {
  createProductInTransaction,
  updateProductInTransaction,
} from "@/infrastructure/shared/product-mutations";
import { normalizeLookupText } from "./stock-load-validation";

const DEFAULT_NEW_PRODUCT_SALE_PRICE = 0;

export type ResolvedStockLoadProduct = {
  id: string;
  name: string;
  price: number;
  sku: string | null;
  currentQuantity: number;
};

/**
 * Resolve or create the stock-load target product inside the transaction.
 * Composite child of stock-load.create (product.resolve-or-create).
 */
export async function resolveStockLoadProduct(
  tx: Prisma.TransactionClient,
  params: {
    businessId: string;
    productId: string;
    itemName: string;
    unitPrice: number | null;
    autoCreateProduct: boolean;
  },
): Promise<ResolvedStockLoadProduct> {
  const { businessId, productId, itemName, unitPrice, autoCreateProduct } = params;

  if (productId) {
    const foundProduct = await tx.product.findFirst({
      where: buildActiveProductWhere({ id: productId, businessId }),
      select: {
        id: true,
        name: true,
        price: true,
        sku: true,
        quantity: true,
      },
    });

    if (!foundProduct) {
      throw new Error("PRODUCT_NOT_FOUND");
    }

    const resolvedProduct = await updateProductInTransaction(tx, {
      businessId,
      productId: foundProduct.id,
      ...(unitPrice !== null ? { costPrice: unitPrice } : {}),
    });

    return {
      id: resolvedProduct.id,
      name: resolvedProduct.name,
      price: resolvedProduct.price,
      sku: resolvedProduct.sku,
      currentQuantity: foundProduct.quantity,
    };
  }

  const existingProducts = await tx.product.findMany({
    where: buildActiveProductWhere({ businessId }),
    select: {
      id: true,
      name: true,
      price: true,
      sku: true,
      quantity: true,
    },
    take: 1000,
  });

  const lookupName = normalizeLookupText(itemName);
  const foundProduct =
    existingProducts.find((entry) => normalizeLookupText(entry.name) === lookupName) ??
    existingProducts.find((entry) => {
      const entryName = normalizeLookupText(entry.name);
      // Require search term to cover at least 50% of product name to prevent
      // false positives like "pan" matching "company"
      return entryName.includes(lookupName) && lookupName.length >= entryName.length * 0.5;
    }) ??
    null;

  if (foundProduct) {
    const resolvedProduct = await updateProductInTransaction(tx, {
      businessId,
      productId: foundProduct.id,
      ...(unitPrice !== null ? { costPrice: unitPrice } : {}),
    });

    return {
      id: resolvedProduct.id,
      name: resolvedProduct.name,
      price: resolvedProduct.price,
      sku: resolvedProduct.sku,
      currentQuantity: foundProduct.quantity,
    };
  }

  if (!autoCreateProduct) {
    throw new Error("PRODUCT_NOT_FOUND_AUTO_CREATE_DISABLED");
  }
  if (unitPrice === null) {
    throw new Error("UNIT_PRICE_REQUIRED_FOR_NEW_PRODUCT");
  }

  const createdProduct = await createProductInTransaction(tx, {
    businessId,
    name: itemName,
    // Si la carga de stock crea un producto nuevo, solo conocemos el costo.
    // Guardar precio de venta = costo fuerza margen cero sin consentimiento.
    // Dejamos el precio de venta en 0 para que el usuario lo defina después.
    price: DEFAULT_NEW_PRODUCT_SALE_PRICE,
    costPrice: unitPrice,
  });

  return {
    id: createdProduct.id,
    name: createdProduct.name,
    price: createdProduct.price,
    sku: createdProduct.sku,
    currentQuantity: 0,
  };
}

export type StockLoadMovement = {
  id: string;
  createdAt: Date;
};

/**
 * Increment inventory and write the stock movement record in-transaction.
 */
export async function applyStockLoadInventoryUpdate(
  tx: Prisma.TransactionClient,
  params: {
    businessId: string;
    product: ResolvedStockLoadProduct;
    quantity: number;
    unitPrice: number | null;
  },
): Promise<{
  stockMovement: StockLoadMovement;
  quantityBefore: number;
  quantityAfter: number;
  totalCost: number;
  cashMovementId: null;
}> {
  const { businessId, product, quantity, unitPrice } = params;
  const quantityBefore = product.currentQuantity;
  const quantityAfter = quantityBefore + quantity;
  const totalCost = unitPrice === null ? 0 : Number((unitPrice * quantity).toFixed(2));

  // Increment stock directly on Product
  await tx.product.update({
    where: { id: product.id, businessId },
    data: { quantity: { increment: quantity } },
  });

  // Stock loads do NOT create cash movements — loading inventory is a stock
  // operation only. If the user paid for the goods, they register the expense
  // separately through the cash movement flow.
  const cashMovementId: string | null = null;

  const stockMovement = await tx.stockMovement.create({
    data: {
      businessId,
      productId: product.id,
      productName: product.name,
      quantityBefore,
      quantityAfter,
      delta: quantity,
      unitCost: unitPrice ?? undefined,
      reason: "stock_load",
      referenceId: cashMovementId,
    },
    select: { id: true, createdAt: true },
  });

  return { stockMovement, quantityBefore, quantityAfter, totalCost, cashMovementId };
}
