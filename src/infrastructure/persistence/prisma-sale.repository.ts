import { prisma } from "@/lib/prisma";
import type { SaleRepositoryPort, CreateSaleTransactionArgs, CreateSaleTransactionResult } from "@/domain/ports/sale.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { runSaleTransaction } from "@/infrastructure/shared/sale-transaction";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

export const prismaSaleRepository: SaleRepositoryPort = {
  async checkEntitiesExist(businessId: string, productIds: string[], customerId: string | null): Promise<string[]> {
    const missing: string[] = [];
    if (productIds.length > 0) {
      const existing = await prisma.product.findMany({
        where: { id: { in: productIds }, businessId },
        select: { id: true },
      });
      const existingSet = new Set(existing.map(p => p.id));
      for (const pid of productIds) {
        if (!existingSet.has(pid)) missing.push(pid);
      }
    }
    if (customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: customerId, businessId },
        select: { id: true },
      });
      if (!customer) missing.push(customerId);
    }
    return missing;
  },

  async createTransaction(tx: Tx, args: CreateSaleTransactionArgs): Promise<CreateSaleTransactionResult> {
    const prismaTx = toPrismaTx(tx);
    const result = await runSaleTransaction(prismaTx, args);
    return {
      sale: { id: result.sale.id, totalAmount: Number(result.sale.totalAmount), status: result.sale.status, date: result.sale.date },
      invoice: result.invoice,
      lowStockAlerts: result.lowStockAlerts,
      whatsappPhone: result.whatsappPhone,
      notifyLowStockWa: result.notifyLowStockWa,
      auditMeta: result.auditMeta,
      idempotencyResponseBody: {
        sale: { id: result.idempotencyResponseBody.sale.id, totalAmount: Number(result.idempotencyResponseBody.sale.totalAmount), status: result.idempotencyResponseBody.sale.status },
        invoice: result.idempotencyResponseBody.invoice,
      },
    };
  },
};
