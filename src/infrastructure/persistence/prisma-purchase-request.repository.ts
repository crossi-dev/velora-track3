import { prisma } from "@/lib/prisma";
import type { PurchaseRequestRepositoryPort, PurchaseRequestCreateArgs, PurchaseRequestListRecord } from "@/domain/ports/purchase-request.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { resolveOrCreateSupplierInTransaction } from "@/app/api/_lib/supplier-resolution";
import { createPurchaseRequestInTransaction } from "@/app/api/_lib/purchase-request-creation";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

export const prismaPurchaseRequestRepository: PurchaseRequestRepositoryPort = {
  async list(businessId: string): Promise<PurchaseRequestListRecord[]> {
    const rows = await prisma.purchaseRequest.findMany({
      where: { businessId },
      select: { id: true, requestNumber: true, issuedAt: true, currency: true, totalAmount: true, supplierId: true },
      orderBy: { issuedAt: "desc" },
      take: 100,
    });
    return rows.map((r) => ({ ...r, totalAmount: Number(r.totalAmount) }));
  },

  async createInTransaction(tx: Tx, args: PurchaseRequestCreateArgs) {
    const prismaTx = toPrismaTx(tx);

    const business = await prismaTx.business.findUnique({
      where: { id: args.businessId },
      select: { name: true, currency: true, cuit: true, address: true },
    });
    if (!business) throw new Error("BUSINESS_NOT_FOUND");

    const supplier = await resolveOrCreateSupplierInTransaction(prismaTx, {
      businessId: args.businessId,
      supplierId: args.supplierId,
      supplierName: args.supplierName,
      allowCreate: true,
      allowContainsMatch: true,
      throwOnSupplierIdMiss: Boolean(args.supplierId),
    });

    return createPurchaseRequestInTransaction(prismaTx, {
      businessId: args.businessId,
      business,
      supplier,
      input: { itemName: args.itemName, quantity: args.quantity, unitPrice: args.unitPrice },
    });
  },
};
