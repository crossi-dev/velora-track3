import { prisma } from "@/lib/prisma";
import type { ProductRepositoryPort, ProductRecord, ProductCreateArgs, ProductUpdateArgs, ProductForDelete, ResolvedProductRecord, ResolveOrCreateOutcome } from "@/domain/ports/product.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { createProductInTransaction, updateProductInTransaction } from "@/infrastructure/shared/product-mutations";
import { initInventory, applyStockAdjustment } from "@/infrastructure/shared/product-stock";
import { withSkuRetry, buildActiveProductWhere, ARCHIVED_PRODUCT_SKU_PREFIX, isProductSkuCollision } from "@/infrastructure/shared/product-sku";
import { normalizeLookupText } from "@/lib/shared-utils";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

function isPrismaNameCollision(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code !== "P2002") return false;
  const meta = "meta" in error ? (error as { meta?: { target?: unknown } }).meta : undefined;
  const target = meta?.target;
  if (Array.isArray(target)) return target.includes("name");
  if (typeof target === "string") return target.includes("name");
  return error instanceof Error && /name/i.test(error.message) && /unique/i.test(error.message);
}

export const prismaProductRepository: ProductRepositoryPort = {
  async findForDelete(businessId: string, productId: string): Promise<ProductForDelete | null> {
    const row = await prisma.product.findFirst({
      where: buildActiveProductWhere({ id: productId, businessId }),
      select: {
        id: true, name: true, price: true, sku: true, costPrice: true, quantity: true,
        _count: { select: { saleItems: true, stockMovements: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      price: Number(row.price),
      costPrice: row.costPrice != null ? Number(row.costPrice) : null,
      sku: row.sku,
      stock: row.quantity,
      saleItemsCount: row._count.saleItems,
      stockMovementsCount: row._count.stockMovements,
    };
  },

  async createWithSkuRetry(args: ProductCreateArgs, onCreated): Promise<ProductRecord> {
    return withSkuRetry(prisma, (client) =>
      client.$transaction(async (tx) => {
        const product = await createProductInTransaction(tx, {
          businessId: args.businessId,
          name: args.name,
          price: args.price,
          costPrice: args.costPrice,
          weightGrams: args.weightGrams,
        });
        await initInventory(tx, {
          businessId: args.businessId,
          productId: product.id,
          productName: product.name,
          initialStock: args.initialStock,
          stockReason: args.stockReason,
          stockReferenceId: args.stockReferenceId,
        });
        const record: ProductRecord = { ...product, weightGrams: args.weightGrams ?? null, stock: args.initialStock };
        await onCreated(tx as unknown as Tx, record);
        return record;
      })
    );
  },

  async updateInTransaction(tx: Tx, args: ProductUpdateArgs) {
    const prismaTx = toPrismaTx(tx);
    const updated = await updateProductInTransaction(prismaTx, {
      businessId: args.businessId,
      productId: args.productId,
      name: args.name,
      price: args.price,
      costPrice: args.costPrice,
      weightGrams: args.weightGrams,
      sku: args.sku,
    });

    if (args.stockQuantity !== undefined) {
      await applyStockAdjustment(prismaTx, {
        businessId: args.businessId,
        productId: updated.id,
        productName: updated.name,
        stockQuantity: args.stockQuantity,
        stockReason: args.stockReason,
        stockReferenceId: args.stockReferenceId,
      });
    }

    return { productId: updated.id, productName: updated.name, updatedSku: args.sku !== undefined ? updated.sku : undefined };
  },

  async fetchForBulkPriceUpdate(businessId: string, productIds: string[]) {
    const where = buildActiveProductWhere(
      productIds.length > 0
        ? { businessId, id: { in: productIds } }
        : { businessId }
    );
    const rows = await prisma.product.findMany({
      where,
      select: { id: true, name: true, price: true },
      take: 2000,
    });
    return rows.map((r) => ({ id: r.id, name: r.name, price: Number(r.price) }));
  },

  async fetchNamesForAudit(businessId: string, productIds: string[]): Promise<Array<{ id: string; name: string }>> {
    const rows = await prisma.product.findMany({
      where: buildActiveProductWhere({ businessId, id: { in: productIds } }),
      select: { id: true, name: true },
    });
    return rows;
  },

  async bulkUpdatePricesInTransaction(tx: Tx, businessId: string, updates: Array<{ id: string; newPrice: number }>) {
    const prismaTx = toPrismaTx(tx);
    for (const update of updates) {
      await prismaTx.product.update({
        where: { id: update.id, businessId },
        data: { price: update.newPrice },
      });
    }
  },

  async resolveOrCreateWithSkuRetry(
    businessId: string,
    args: { name: string; price: number; costPrice?: number | null },
    normalizedName: string,
    onCreated: (tx: Tx, product: ResolvedProductRecord) => Promise<void>
  ): Promise<ResolveOrCreateOutcome> {
    const toRecord = (r: { id: string; name: string; price: unknown; costPrice: unknown; sku: string | null }): ResolvedProductRecord => ({
      id: r.id, name: r.name,
      price: Number(r.price),
      costPrice: r.costPrice != null ? Number(r.costPrice) : null,
      sku: r.sku,
    });

    const lookup = async (): Promise<ResolvedProductRecord | null> => {
      const rows = await prisma.product.findMany({
        where: buildActiveProductWhere({ businessId }),
        select: { id: true, name: true, price: true, costPrice: true, sku: true },
        take: 2000,
      });
      const match = rows.find((r) => normalizeLookupText(r.name) === normalizedName);
      return match ? toRecord(match) : null;
    };

    const existing = await lookup();
    if (existing) return { outcome: "resolved", product: existing };

    try {
      const created = await withSkuRetry(prisma, (client) =>
        client.$transaction(async (tx) => {
          const product = await createProductInTransaction(tx, {
            businessId, name: args.name, price: args.price, costPrice: args.costPrice,
          });
          const record: ResolvedProductRecord = {
            id: product.id, name: product.name, price: product.price,
            costPrice: product.costPrice, sku: product.sku,
          };
          await onCreated(tx as unknown as Tx, record);
          return record;
        })
      );
      return { outcome: "created", product: created };
    } catch (error) {
      if (isPrismaNameCollision(error)) {
        const winner = await lookup();
        if (winner) return { outcome: "resolved", product: winner };
        throw error;
      }
      if (isProductSkuCollision(error)) return { outcome: "sku_collision" };
      throw error;
    }
  },

  async deleteInTransaction(tx: Tx, args: { businessId: string; productId: string }) {
    const prismaTx = toPrismaTx(tx);
    // Tenant-scoped count read: prevents TOCTOU where an unscoped findFirst
    // could count sale items for a different tenant's product with the same id.
    const freshCounts = await prismaTx.product.findFirst({
      where: { id: args.productId, businessId: args.businessId },
      select: { _count: { select: { saleItems: true } } },
    });
    const hasSaleItems = (freshCounts?._count.saleItems ?? 0) > 0;

    if (hasSaleItems) {
      // Defense-in-depth tenant guard: scope write by both id+businessId.
      await prismaTx.product.update({
        where: { id: args.productId, businessId: args.businessId },
        data: { sku: `${ARCHIVED_PRODUCT_SKU_PREFIX}${args.productId}`, quantity: 0 },
      });
      return { archived: true };
    }

    // Scope both deletes by businessId to prevent cross-tenant data destruction.
    await prismaTx.stockMovement.deleteMany({ where: { productId: args.productId, businessId: args.businessId } });
    await prismaTx.product.deleteMany({ where: { id: args.productId, businessId: args.businessId } });
    return { archived: false };
  },
};
