import type { Prisma } from "@prisma/client";
import {
  buildActiveProductWhere,
  generateUniqueSkuForBusiness,
  normalizeProvidedSku,
} from "@/infrastructure/shared/product-sku";
import { ProductNameRequiredError, ProductNotFoundError } from "@/domain/errors";

type ProductMutationClient = Prisma.TransactionClient;

export type ProductMutationRecord = {
  id: string;
  name: string;
  price: number;
  costPrice: number | null;
  sku: string | null;
};

const MAX_PRODUCT_NAME_LENGTH = 500;

export function normalizeProductName(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_PRODUCT_NAME_LENGTH);
}

export function parseProductNonNegativeNumber(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export function parseProductNonNegativeInteger(value: unknown) {
  const parsed = parseProductNonNegativeNumber(value);
  return parsed === null ? null : Math.floor(parsed);
}

export function normalizeStockReason(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || "manual";
}

export function normalizeStockReferenceId(value: unknown) {
  return typeof value === "string" ? value.trim() || null : null;
}

function ensureNormalizedProductName(value: unknown) {
  const normalized = normalizeProductName(value);
  if (!normalized) {
    throw new ProductNameRequiredError();
  }
  return normalized;
}

function ensureNonNegativeNumber(value: unknown, errorMessage: string) {
  const parsed = parseProductNonNegativeNumber(value);
  if (parsed === null) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function selectProductRecord(product: {
  id: string;
  name: string;
  price: Prisma.Decimal;
  costPrice: Prisma.Decimal | null;
  sku: string | null;
}): ProductMutationRecord {
  return {
    id: product.id,
    name: product.name,
    price: Number(product.price),
    costPrice: product.costPrice !== null ? Number(product.costPrice) : null,
    sku: product.sku,
  };
}

export async function createProductInTransaction(
  tx: ProductMutationClient,
  args: {
    businessId: string;
    name: unknown;
    price: unknown;
    costPrice?: unknown;
    /** Weight in grams. Null/undefined when not provided. */
    weightGrams?: number | null;
    sku?: unknown;
  }
): Promise<ProductMutationRecord> {
  const name = ensureNormalizedProductName(args.name);
  const price = ensureNonNegativeNumber(args.price, "PRODUCT_PRICE_INVALID");
  const costPrice =
    args.costPrice === undefined
      ? null
      : args.costPrice === null
        ? null
        : ensureNonNegativeNumber(args.costPrice, "PRODUCT_COST_PRICE_INVALID");
  const sku =
    normalizeProvidedSku(args.sku) ??
    (await generateUniqueSkuForBusiness(tx, {
      businessId: args.businessId,
      productName: name,
    }));

  const created = await tx.product.create({
    data: {
      businessId: args.businessId,
      name,
      price,
      costPrice,
      weightGrams: args.weightGrams ?? null,
      sku,
    },
    select: {
      id: true,
      name: true,
      price: true,
      costPrice: true,
      sku: true,
    },
  });

  return selectProductRecord(created);
}

export async function updateProductInTransaction(
  tx: ProductMutationClient,
  args: {
    businessId: string;
    productId: string;
    name?: unknown;
    price?: unknown;
    costPrice?: unknown;
    /** Weight in grams. Null explicitly clears. Undefined = no change. */
    weightGrams?: number | null;
    sku?: unknown;
  }
): Promise<ProductMutationRecord> {
  const product = await tx.product.findFirst({
    where: buildActiveProductWhere({ id: args.productId, businessId: args.businessId }),
    select: {
      id: true,
      name: true,
      price: true,
      costPrice: true,
      sku: true,
    },
  });

  if (!product) {
    throw new ProductNotFoundError();
  }

  const normalizedName = args.name !== undefined ? normalizeProductName(args.name) : undefined;
  if (args.name !== undefined && !normalizedName) {
    throw new ProductNameRequiredError();
  }

  const parsedPrice =
    args.price !== undefined ? ensureNonNegativeNumber(args.price, "PRODUCT_PRICE_INVALID") : undefined;

  const parsedCostPrice =
    args.costPrice === undefined
      ? undefined
      : args.costPrice === null
        ? null
        : ensureNonNegativeNumber(args.costPrice, "PRODUCT_COST_PRICE_INVALID");

  const currentSku = normalizeProvidedSku(product.sku);
  const nextSku =
    args.sku !== undefined
      ? normalizeProvidedSku(args.sku) ??
        (await generateUniqueSkuForBusiness(tx, {
          businessId: args.businessId,
          productName: normalizedName ?? product.name,
          excludeProductId: product.id,
        }))
      : currentSku ??
        (await generateUniqueSkuForBusiness(tx, {
          businessId: args.businessId,
          productName: normalizedName ?? product.name,
          excludeProductId: product.id,
        }));

  const updateData: {
    name?: string;
    price?: number;
    costPrice?: number | null;
    weightGrams?: number | null;
    sku?: string | null;
  } = {};

  if (normalizedName !== undefined) {
    updateData.name = normalizedName;
  }
  if (parsedPrice !== undefined) {
    updateData.price = parsedPrice;
  }
  if (parsedCostPrice !== undefined) {
    updateData.costPrice = parsedCostPrice;
  }
  // undefined = no change; null = clear; positive int = set
  if (args.weightGrams !== undefined) {
    updateData.weightGrams = args.weightGrams;
  }
  if (nextSku !== undefined) {
    updateData.sku = nextSku;
  }

  if (Object.keys(updateData).length > 0) {
    // Defense-in-depth tenant guard: scope write by both id+businessId so the
    // update cannot touch a row from another tenant even if product.id leaked.
    const updated = await tx.product.update({
      where: { id: product.id, businessId: args.businessId },
      data: updateData,
      select: {
        id: true,
        name: true,
        price: true,
        costPrice: true,
        sku: true,
      },
    });
    return selectProductRecord(updated);
  }

  return selectProductRecord(product);
}
