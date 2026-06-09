import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { buildActiveProductWhere, normalizeProvidedSku } from "@/infrastructure/shared/product-sku";
import {
  createProductInTransaction,
  normalizeProductName,
  updateProductInTransaction,
} from "@/infrastructure/shared/product-mutations";
import {
  cellStr,
  colIndex,
  parseImportNonNegativeInteger,
  parseImportNonNegativeNumber,
} from "./import-parsing";

type TxClient = Prisma.TransactionClient;

export type ImportCounters = { imported: number; skipped: number };

export type ImportProductsResult =
  | { ok: true; counters: ImportCounters }
  | { ok: false; response: NextResponse };

/**
 * Imports product rows inside an already-open transaction.
 * Uses import-specific row mapping and stock sync; delegates canonical
 * product ownership to product-mutations helpers.
 */
export async function importProductRows(
  tx: TxClient,
  params: { businessId: string; headers: string[]; dataRows: unknown[][] }
): Promise<ImportProductsResult> {
  const { businessId, headers, dataRows } = params;

  const iName = colIndex(headers, "nombre", "name", "producto", "product", "descripcion", "descripción", "description");
  const iPrice = colIndex(headers, "precio", "price", "costo", "cost", "valor", "value");
  const iStock = colIndex(headers, "stock", "cantidad", "quantity", "qty", "existencia");
  const iSku = colIndex(headers, "sku", "codigo", "código", "code", "referencia", "ref");

  if (iName === -1) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No se encontró la columna 'nombre'." }, { status: 400 }),
    };
  }

  const counters: ImportCounters = { imported: 0, skipped: 0 };

  // Pre-load all active products for this business to avoid N+1 findFirst calls.
  const allExistingProducts = await tx.product.findMany({
    where: buildActiveProductWhere({ businessId }),
    select: { id: true, name: true, sku: true, quantity: true },
  });
  const productsByName = new Map(
    allExistingProducts.map((p) => [p.name.toLowerCase(), p])
  );
  const productsBySku = new Map(
    allExistingProducts
      .filter((p) => p.sku !== null)
      .map((p) => [p.sku!.toUpperCase(), p])
  );

  // Pre-load current quantities — now on Product directly.
  const inventoryByProductId = new Map(
    allExistingProducts.map((p) => [p.id, { productId: p.id, quantity: p.quantity }])
  );

  for (const [index, row] of dataRows.entries()) {
    const name = cellStr(row as unknown[], iName);
    const normalizedName = normalizeProductName(name);
    if (!normalizedName) {
      counters.skipped++;
      continue;
    }
    const priceIsBlank = cellStr(row as unknown[], iPrice) === "";
    const stockIsBlank = cellStr(row as unknown[], iStock) === "";
    const price = parseImportNonNegativeNumber((row as unknown[])[iPrice]);
    const stock = parseImportNonNegativeInteger((row as unknown[])[iStock]);
    const requestedSku = normalizeProvidedSku(cellStr(row as unknown[], iSku));

    if (price === null) {
      throw new Error(`IMPORT_INVALID_PRICE:${index + 2}`);
    }
    if (stock === null) {
      throw new Error(`IMPORT_INVALID_STOCK:${index + 2}`);
    }

    const existingBySku = requestedSku
      ? (productsBySku.get(requestedSku.toUpperCase()) ?? null)
      : null;
    const existingByName = productsByName.get(normalizedName.toLowerCase()) ?? null;
    const existing = existingBySku ?? existingByName;

    if (existing) {
      const currentInventory = inventoryByProductId.get(existing.id);
      const quantityBefore = currentInventory?.quantity ?? 0;
      const quantityAfter = stockIsBlank ? quantityBefore : stock;

      const updatedProduct = await updateProductInTransaction(tx, {
        businessId,
        productId: existing.id,
        name: normalizedName,
        ...(priceIsBlank ? {} : { price }),
        sku: requestedSku,
      });
      if (!stockIsBlank) {
        await tx.product.update({
          where: { id: existing.id },
          data: { quantity: stock },
        });
      }

      if (quantityAfter !== quantityBefore) {
        await tx.stockMovement.create({
          data: {
            businessId,
            productId: existing.id,
            productName: updatedProduct.name,
            quantityBefore,
            quantityAfter,
            delta: quantityAfter - quantityBefore,
            reason: "import",
          },
        });
      }
    } else {
      const product = await createProductInTransaction(tx, {
        businessId,
        name: normalizedName,
        price,
        sku: requestedSku,
      });
      const initialStock = stockIsBlank ? 0 : stock;
      if (initialStock > 0) {
        await tx.product.update({
          where: { id: product.id },
          data: { quantity: initialStock },
        });
      }

      if (initialStock > 0) {
        await tx.stockMovement.create({
          data: {
            businessId,
            productId: product.id,
            productName: product.name,
            quantityBefore: 0,
            quantityAfter: initialStock,
            delta: initialStock,
            reason: "import",
          },
        });
      }
    }
    counters.imported++;
  }

  return { ok: true, counters };
}
