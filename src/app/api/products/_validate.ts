import { NextRequest } from "next/server";
import { badRequest } from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { createProductBodySchema, updateProductBodySchema } from "./product-schema";
import {
  normalizeProductName,
  parseProductNonNegativeInteger,
  parseProductNonNegativeNumber,
  normalizeStockReason,
  normalizeStockReferenceId,
} from "@/infrastructure/shared/product-mutations";
import { validateProductName, validateProductPrice } from "@/domain/rules";

export type ValidatedPostBody = {
  normalizedName: string;
  numericPrice: number;
  numericStock: number;
  stockReason: string;
  stockReferenceId: string | null;
  costPrice: number | null;
  weightGrams?: number | null;
  rawData: Record<string, unknown>;
};

export type ValidatedPatchBody = {
  id: string;
  name: unknown;
  price: unknown;
  costPrice: unknown;
  stock: unknown;
  sku: unknown;
  weightGrams?: number | null;
  stockReason: string;
  stockReferenceId: string | null;
  hasProductFields: boolean;
  hasStockField: boolean;
  isStockOnlyAdjustment: boolean;
  productUpdateData: {
    name?: string;
    price?: number;
    costPrice?: number | null;
    sku?: string | null;
    weightGrams?: number | null;
  };
  stockQuantity: number | undefined;
  rawData: Record<string, unknown>;
};


export async function validatePostBody(
  req: NextRequest
): Promise<{ ok: true; data: ValidatedPostBody } | { ok: false; response: Response }> {
  const parsed = await parseZodBody(req, createProductBodySchema);
  if (!parsed.ok) return { ok: false, response: parsed.response };

  const normalizedName = normalizeProductName(parsed.data.name);
  if (!normalizedName || validateProductName(normalizedName) !== null) {
    return { ok: false, response: badRequest("El nombre es obligatorio.") };
  }

  const numericPrice = parseProductNonNegativeNumber(parsed.data.price);
  if (numericPrice === null) {
    return { ok: false, response: badRequest("El precio debe ser un número mayor o igual a cero.") };
  }

  const numericStock = parseProductNonNegativeInteger(parsed.data.stock);
  if (numericStock === null) {
    return { ok: false, response: badRequest("El stock debe ser un número mayor o igual a cero.") };
  }

  const stockReason = normalizeStockReason(parsed.data.stockReason);
  const stockReferenceId = normalizeStockReferenceId(parsed.data.stockReferenceId);
  const costPrice = parseProductNonNegativeNumber(parsed.data.costPrice);
  const weightGrams = parsed.data.weightGrams ?? null;

  return {
    ok: true,
    data: {
      normalizedName,
      numericPrice,
      numericStock,
      stockReason,
      stockReferenceId,
      costPrice,
      weightGrams,
      rawData: parsed.data as Record<string, unknown>,
    },
  };
}

export async function validatePatchBody(
  req: NextRequest
): Promise<{ ok: true; data: ValidatedPatchBody } | { ok: false; response: Response }> {
  const parsed = await parseZodBody(req, updateProductBodySchema);
  if (!parsed.ok) return { ok: false, response: parsed.response };

  const id = typeof parsed.data.id === "string" ? parsed.data.id.trim() : "";
  if (!id) {
    return { ok: false, response: badRequest("Hace falta el identificador del producto.") };
  }

  const { name, price, costPrice, stock, sku, weightGrams } = parsed.data;
  const stockReason = normalizeStockReason(parsed.data.stockReason);
  const stockReferenceId = normalizeStockReferenceId(parsed.data.stockReferenceId);

  const hasProductFields =
    name !== undefined || price !== undefined || costPrice !== undefined || sku !== undefined || weightGrams !== undefined;
  const hasStockField = stock !== undefined;
  const isStockOnlyAdjustment = hasStockField && !hasProductFields;

  if (!hasProductFields && !hasStockField) {
    return { ok: false, response: badRequest("No se enviaron cambios para el producto.") };
  }

  const productUpdateData: {
    name?: string;
    price?: number;
    costPrice?: number | null;
    sku?: string | null;
    weightGrams?: number | null;
  } = {};

  if (name !== undefined) {
    const normalizedName = normalizeProductName(name);
    if (!normalizedName || validateProductName(normalizedName) !== null) {
      return { ok: false, response: badRequest("El nombre del producto no puede estar vacío.") };
    }
    productUpdateData.name = normalizedName;
  }

  if (price !== undefined) {
    const numericPrice = parseProductNonNegativeNumber(price);
    if (numericPrice === null || validateProductPrice(numericPrice) !== null) {
      return { ok: false, response: badRequest("El precio debe ser mayor a cero.") };
    }
    productUpdateData.price = numericPrice;
  }

  if (costPrice !== undefined) {
    if (costPrice === null) {
      productUpdateData.costPrice = null;
    } else {
      const numericCostPrice = parseProductNonNegativeNumber(costPrice);
      if (numericCostPrice === null) {
        return {
          ok: false,
          response: badRequest("El costo debe ser un número mayor o igual a cero o vacío."),
        };
      }
      productUpdateData.costPrice = numericCostPrice;
    }
  }

  if (weightGrams !== undefined) {
    productUpdateData.weightGrams = weightGrams === null ? null : weightGrams;
  }

  const stockQuantity = hasStockField ? parseProductNonNegativeInteger(stock) : undefined;
  if (hasStockField && stockQuantity === null) {
    return { ok: false, response: badRequest("El stock debe ser un número mayor o igual a cero.") };
  }

  return {
    ok: true,
    data: {
      id,
      name,
      price,
      costPrice,
      stock,
      sku,
      weightGrams,
      stockReason,
      stockReferenceId,
      hasProductFields,
      hasStockField,
      isStockOnlyAdjustment,
      productUpdateData,
      stockQuantity: stockQuantity ?? undefined,
      rawData: parsed.data as Record<string, unknown>,
    },
  };
}
