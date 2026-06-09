import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import { auditStockLoadCreated } from "@/app/api/stock-loads/_lib/stock-load-audit";
import type { StockLoadAuditPort, StockLoadAuditInput } from "@/domain/ports/stock-load.repository.port";

const STOCK_LOAD_ACTION = getServerActionMeta("stock-load.create");

export const prismaStockLoadAuditAdapter: StockLoadAuditPort = {
  async recordAudit(params: StockLoadAuditInput): Promise<void> {
    const { actorUserId, actorEmployeeId, businessId, actionMeta, ...meta } = params;

    await auditStockLoadCreated({
      actorUserId,
      actorEmployeeId,
      businessId,
      action: STOCK_LOAD_ACTION,
      auditMeta: {
        actionOwner: actionMeta.actionType,
        internalSubsteps: [
          "product.resolve-or-create",
          "inventory.increment",
          "stock-movement.create",
          "cash-movement.create",
          "supplier.resolve-or-create",
          "purchase-request.create",
        ],
        stockMovementId: meta.stockMovementId,
        productId: meta.productId,
        productName: meta.productName,
        supplierId: meta.supplierId,
        supplierName: meta.supplierName,
        cashMovementId: meta.cashMovementId,
        purchaseRequestId: meta.purchaseRequestId,
        quantity: meta.quantity,
        unitPrice: meta.unitPrice,
        totalCost: meta.totalCost,
      },
    });
  },
};
