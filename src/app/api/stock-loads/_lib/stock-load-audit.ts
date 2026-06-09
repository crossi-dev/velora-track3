import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";

export type StockLoadAuditMeta = {
  actionOwner: string;
  internalSubsteps: ReadonlyArray<string>;
  stockMovementId: string;
  productId: string;
  productName: string;
  supplierId: string | null;
  supplierName: string | null;
  cashMovementId: string | null;
  purchaseRequestId: string | null;
  quantity: number;
  unitPrice: number | null;
  totalCost: number;
};

/**
 * Single call site for the stock-load.create critical-write audit event.
 * The route guardrail checks for exactly ONE recordCriticalWriteEvent in
 * this route tree, so keep this the only place that invokes it.
 */
export async function auditStockLoadCreated(params: {
  actorUserId: string;
  actorEmployeeId?: string | null;
  businessId: string;
  action: ReturnType<typeof getServerActionMeta>;
  auditMeta: StockLoadAuditMeta;
}): Promise<void> {
  const { actorUserId, actorEmployeeId, businessId, action, auditMeta } = params;

  await recordCriticalWriteEvent({
    client: prisma,
    businessId,
    actorUserId,
    actorEmployeeId,
    routeScope: action.routeScope,
    actionType: action.actionType,
    resourceType: action.resourceType,
    resourceId: auditMeta.stockMovementId,
    summary: `Carga de stock de ${auditMeta.quantity} ${auditMeta.productName}`,
    payload: auditMeta,
    input: auditMeta,
    after: { productId: auditMeta.productId, productName: auditMeta.productName, quantity: auditMeta.quantity, supplierId: auditMeta.supplierId },
  });
}
