import type { Prisma } from "@prisma/client";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";
import { cloudLog } from "@/lib/cloud-logger";
import { detectStockShortfall } from "@/domain/rules";
import { InsufficientStockError } from "@/domain/errors";
import { lineTotal } from "@/lib/money";

export type InventoryLookupClient = {
  product: {
    findMany: Prisma.TransactionClient["product"]["findMany"];
  };
};

export async function loadInventoryRecords(
  client: InventoryLookupClient,
  productIds: string[],
  businessId: string
): Promise<Array<{
  productId: string;
  quantity: number;
  product: {
    name: string;
    businessId: string;
    costPrice: number | null;
    price: number;
  };
}>> {
  const records = await client.product.findMany({
    where: { businessId, id: { in: productIds } },
    select: { id: true, name: true, businessId: true, costPrice: true, price: true, quantity: true },
  });

  return records.map((record) => ({
    productId: record.id,
    quantity: record.quantity,
    product: {
      name: record.name,
      businessId: record.businessId,
      costPrice: record.costPrice ? Number(record.costPrice) : null,
      price: Number(record.price),
    },
  }));
}

export type CheckedItem = {
  productId: string;
  quantity: number;
  unitPrice: number;
  productName: string;
  unitCost: number | null;
};

export async function processCheckedItemsInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    checkedItems: CheckedItem[];
    saleId: string;
    businessId: string;
    allowNegativeStock: boolean;
  }
): Promise<{
  saleItemsForInvoice: InvoicePayload["sale"]["items"];
  lowStockAlerts: Array<{ productId: string; productName: string; remainingUnits: number; reorderThreshold: number }>;
}> {
  const { checkedItems, saleId, businessId, allowNegativeStock } = args;

  await createSaleItemsBatch(tx, saleId, checkedItems);
  const inventoryByProduct = await loadInventoryForSale(tx, checkedItems.map((i) => i.productId), businessId);

  // ── Step 3: Update inventory per item (conditional, must be individual) ──
  const lowStockAlerts: Array<{ productId: string; productName: string; remainingUnits: number; reorderThreshold: number }> = [];
  const stockMovementData: Array<{
    businessId: string;
    productId: string;
    productName: string;
    quantityBefore: number;
    quantityAfter: number;
    delta: number;
    reason: string;
    referenceId: string;
    unitCost: number | null;
  }> = [];
  const saleItemsForInvoice: InvoicePayload["sale"]["items"] = [];

  for (const item of checkedItems) {
    const inv = inventoryByProduct.get(item.productId);
    const qtyBefore = inv?.quantity ?? 0;

    // Early domain-rule check — clean error before the atomic DB guard below.
    // The updateMany is the TOCTOU guard (race-condition defense).
    if (!allowNegativeStock) {
      const shortfall = detectStockShortfall(item.quantity, qtyBefore);
      if (shortfall) throw new InsufficientStockError(inv?.product.name ?? item.productName, shortfall.available);
    }

    const stockUpdate = await tx.product.updateMany({
      where: {
        id: item.productId,
        businessId,  // defense-in-depth: tenant guard
        ...(allowNegativeStock ? {} : { quantity: { gte: item.quantity } }),
      },
      data: {
        quantity: { decrement: item.quantity },
      },
    });

    if (stockUpdate.count !== 1) {
      throw new InsufficientStockError(inv?.product.name ?? item.productName, inv?.quantity ?? 0);
    }

    // Temporary audit trail until a dedicated audit-log table exists.
    // Cloud Logging captures the event; do not add schema changes here.
    if (allowNegativeStock && qtyBefore < item.quantity) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "NEGATIVE_STOCK_APPLIED",
        a2a_transfer: false,
        message: "Sale drove inventory below zero (allowNegativeStock=true)",
        businessId,
        data: {
          saleId,
          productId: item.productId,
          productName: item.productName,
          requestedQty: item.quantity,
          availableQty: qtyBefore,
          resultingQty: qtyBefore - item.quantity,
        },
      });
    }

    // Update the local snapshot so subsequent items sharing the same productId
    // compute an accurate quantityBefore (not the pre-loop stale value).
    const invEntry = inventoryByProduct.get(item.productId);
    if (invEntry) {
      inventoryByProduct.set(item.productId, { ...invEntry, quantity: invEntry.quantity - item.quantity });
    }

    const qtyAfter = qtyBefore - item.quantity;

    // Collect stock movement data for batch insert
    stockMovementData.push({
      businessId,
      productId: item.productId,
      productName: item.productName,
      quantityBefore: qtyBefore,
      quantityAfter: qtyAfter,
      delta: -item.quantity,
      reason: "sale",
      referenceId: saleId,
      unitCost: item.unitCost,
    });

    const reorderThreshold = inv?.product.reorderThreshold ?? 5;
    // Fire only when this sale crosses the threshold downward (not every sub-threshold sale).
    if (qtyAfter >= 0 && qtyBefore >= reorderThreshold && qtyAfter < reorderThreshold) {
      lowStockAlerts.push({
        productId: item.productId,
        productName: inv?.product.name ?? item.productName,
        remainingUnits: qtyAfter,
        reorderThreshold,
      });
    }

    saleItemsForInvoice.push({
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: lineTotal(item.quantity, item.unitPrice).toNumber(), // per-line 2dp ROUND_HALF_UP (Dynamics 365 "Calculation method = Line")
    });
  }

  // ── Step 4: Batch create all stock movements ──────────────────────
  if (stockMovementData.length > 0) {
    if (typeof tx.stockMovement.createMany === "function") {
      await tx.stockMovement.createMany({ data: stockMovementData });
    } else {
      for (const data of stockMovementData) {
        await tx.stockMovement.create({ data });
      }
    }
  }

  return { saleItemsForInvoice, lowStockAlerts };
}

// Immutability contract: `unitPrice` and `unitCost` on SaleItem are written
// exactly once here. Enforced at build time by scripts/check-saleitem-immutable.mjs.
async function createSaleItemsBatch(
  tx: Prisma.TransactionClient,
  saleId: string,
  checkedItems: CheckedItem[]
): Promise<void> {
  if (typeof tx.saleItem.createMany === "function") {
    await tx.saleItem.createMany({
      data: checkedItems.map((item) => ({
        saleId,
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        unitCost: item.unitCost ?? null,
      })),
    });
    return;
  }
  for (const item of checkedItems) {
    await tx.saleItem.create({
      data: {
        saleId,
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        unitCost: item.unitCost ?? null,
      },
    });
  }
}

type InventorySnapshotEntry = {
  productId: string;
  quantity: number;
  product: { name: string; reorderThreshold: number | null };
};

async function loadInventoryForSale(
  tx: Prisma.TransactionClient,
  productIds: string[],
  businessId: string
): Promise<Map<string, InventorySnapshotEntry>> {
  const inventoryByProduct = new Map<string, InventorySnapshotEntry>();
  const records = await tx.product.findMany({
    where: { businessId, id: { in: productIds } },
    select: {
      id: true,
      quantity: true,
      name: true,
      reorderThreshold: true,
    },
  });
  for (const r of records) {
    inventoryByProduct.set(r.id, {
      productId: r.id,
      quantity: r.quantity,
      product: { name: r.name, reorderThreshold: r.reorderThreshold },
    });
  }
  return inventoryByProduct;
}
