import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import type { StockIngressRequestEvent } from "@/lib/agent-contract";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import {
  resolveStockLoadProduct,
  applyStockLoadInventoryUpdate,
} from "@/app/api/stock-loads/_lib/stock-load-products";

export interface StockIngressExecuteResult {
  success: boolean;
  processed: number;
  errors: string[];
}

/**
 * Execute a stock ingress batch atomically.
 *
 * Saga pattern (accounting/inventory SaaS standard 2026):
 * 1. Create a StockLoad parent record (status='in_progress') BEFORE items.
 * 2. Process ALL items inside ONE prisma.$transaction.
 * 3. Mark StockLoad 'completed' inside the same transaction on success.
 * 4. On any failure the transaction rolls back ALL items; catch block marks
 *    StockLoad 'failed' + records errorReason out-of-band.
 *
 * This guarantees partial ingress is never silently committed: the StockLoad
 * row always reflects the final state (completed | failed), making inconsistent
 * stock visible rather than invisible.
 */
export async function executeStockIngress(
  items: StockIngressRequestEvent["items"],
  businessId: string,
  actorEmployeeId: string | null,
): Promise<StockIngressExecuteResult> {
  // Step 1: Write the saga parent record before any item touches the DB.
  const stockLoad = await prisma.stockLoad.create({
    data: {
      businessId,
      status: "in_progress",
      itemCount: items.length,
      completedCount: 0,
    },
    select: { id: true },
  });

  try {
    // Step 2: All items inside a single transaction — all-or-nothing.
    await prisma.$transaction(async (tx) => {
      const prismaTx = tx as unknown as Prisma.TransactionClient;

      for (const item of items) {
        const product = await resolveStockLoadProduct(prismaTx, {
          businessId,
          productId: "",
          itemName: item.productName,
          unitPrice: item.unitCostPrice,
          autoCreateProduct: false,
        });
        await applyStockLoadInventoryUpdate(prismaTx, {
          businessId,
          product,
          quantity: item.quantity,
          unitPrice: item.unitCostPrice,
        });
      }

      // Step 3: Mark completed inside the same transaction so the status flip
      // is atomic with the inventory writes.
      await prismaTx.stockLoad.update({
        where: { id: stockLoad.id },
        data: {
          status: "completed",
          completedCount: items.length,
          completedAt: new Date(),
        },
      });
    });

    invalidateBusinessContext(businessId);
    return { success: true, processed: items.length, errors: [] };
  } catch (err) {
    // Step 4: Transaction rolled back — record failure out-of-band.
    const errorReason = err instanceof Error ? err.message : String(err);
    await prisma.stockLoad
      .update({
        where: { id: stockLoad.id },
        data: { status: "failed", errorReason },
      })
      .catch((updateErr) => {
        // Non-critical: log but do not mask the original error.
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "STOCK_LOAD_STATUS_UPDATE_FAILED",
          a2a_transfer: false,
          message: `failed to mark StockLoad ${stockLoad.id} as failed`,
          businessId,
          data: { stockLoadId: stockLoad.id, updateError: String(updateErr) },
        });
      });

    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "STOCK_INGRESS_BATCH_FAILED",
      a2a_transfer: false,
      message: `stock ingress batch rolled back: ${errorReason}`,
      businessId,
      data: {
        stockLoadId: stockLoad.id,
        itemCount: items.length,
        errorReason,
        actorEmployeeId,
      },
    });

    return { success: false, processed: 0, errors: [errorReason] };
  }
}
