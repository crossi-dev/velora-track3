import type { Prisma } from "@prisma/client";

// Structural type: only the product.findMany method is needed, using
// TransactionClient field types so both plain and extended clients satisfy it.
type ProductSkuClient = {
  product: {
    findMany: Prisma.TransactionClient["product"]["findMany"];
  };
};
export const ARCHIVED_PRODUCT_SKU_PREFIX = "__ELIMINADO__:";

export function normalizeSkuBase(name: string) {
  const normalized = name
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 14)
    .replace(/-+$/, "");

  return normalized || "ITEM";
}

export function buildUniqueSku(base: string, usedSkus: Set<string>) {
  let candidate = base;
  let counter = 1;

  while (usedSkus.has(candidate)) {
    candidate = `${base}-${String(counter).padStart(2, "0")}`;
    counter += 1;
  }

  usedSkus.add(candidate);
  return candidate;
}

export function normalizeProvidedSku(value: unknown) {
  if (value === null || value === undefined) return null;

  const normalized = String(value).trim().toUpperCase();
  return normalized || null;
}

export function normalizeSkuLookup(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

export function isArchivedProductSku(value: unknown) {
  const normalized = normalizeProvidedSku(value);
  return normalized?.startsWith(ARCHIVED_PRODUCT_SKU_PREFIX) ?? false;
}

export function buildArchivedProductSku(productId: string) {
  const normalizedId = normalizeSkuLookup(productId) || "PRODUCTO";
  return `${ARCHIVED_PRODUCT_SKU_PREFIX}${normalizedId}`;
}

export function buildActiveProductWhere(
  where: Prisma.ProductWhereInput = {}
): Prisma.ProductWhereInput {
  return {
    AND: [
      where,
      {
        OR: [
          { sku: null },
          {
            sku: {
              not: {
                startsWith: ARCHIVED_PRODUCT_SKU_PREFIX,
              },
            },
          },
        ],
      },
    ],
  };
}

function collectUsedSkus(products: Array<{ sku: string | null }>) {
  return new Set(
    products
      .map((product) => normalizeProvidedSku(product.sku))
      .filter((sku): sku is string => Boolean(sku))
  );
}

export async function generateUniqueSkuForBusiness(
  client: ProductSkuClient,
  args: { businessId: string; productName: string; excludeProductId?: string }
) {
  const whereClause: Prisma.ProductWhereInput = { businessId: args.businessId };
  if (args.excludeProductId) {
    whereClause.id = { not: args.excludeProductId };
  }

  const existingProducts = await client.product.findMany({
    where: buildActiveProductWhere(whereClause),
    select: { sku: true },
  });

  return buildUniqueSku(normalizeSkuBase(args.productName), collectUsedSkus(existingProducts));
}

const MAX_SKU_RETRIES = 3;

export function isProductSkuCollision(error: unknown) {
  if (error && typeof error === "object") {
    const code = "code" in error ? (error as { code?: unknown }).code : undefined;
    const meta = "meta" in error ? (error as { meta?: { target?: unknown } }).meta : undefined;
    const target = meta?.target;

    if (code === "P2002") {
      if (Array.isArray(target)) {
        return target.includes("businessId") && target.includes("sku");
      }
      if (typeof target === "string") {
        return target.includes("businessId") && target.includes("sku");
      }
      return true;
    }
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);

  return message.includes("businessId") && message.includes("sku");
}

// Minimal structural type for clients that can open a $transaction.
// We use `any` for the callback type to be compatible with both the plain
// PrismaClient and the extended prisma instance, which differ in their tx type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransactableClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction(fn: (tx: any) => Promise<any>): Promise<any>;
};

/**
 * Run a callback that may create a product inside a transaction,
 * retrying on SKU collision up to MAX_SKU_RETRIES times.
 *
 * The `runner` receives the client for each attempt so it can open its own $transaction.
 */
export async function withSkuRetry<T>(
  client: TransactableClient,
  runner: (client: TransactableClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_SKU_RETRIES; attempt += 1) {
    try {
      return await runner(client);
    } catch (error) {
      if (isProductSkuCollision(error)) {
        if (attempt < MAX_SKU_RETRIES - 1) continue;
        throw new Error("PRODUCT_SKU_CONFLICT");
      }
      throw error;
    }
  }
  throw new Error("PRODUCT_SKU_CONFLICT");
}
