import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BudgetRepositoryPort, BudgetRecord, CreateBudgetArgs } from "@/domain/ports/budget.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { nextBusinessCounter } from "@/infrastructure/shared/business-counter";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

async function nextSequenceNumber(
  tx: Prisma.TransactionClient,
  businessId: string,
): Promise<number> {
  const value = await nextBusinessCounter(tx, businessId, "budget");
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export const prismaBudgetRepository: BudgetRepositoryPort = {
  async findById(businessId: string, budgetId: string) {
    return prisma.budget.findFirst({
      where: { id: budgetId, businessId },
      select: { id: true },
    });
  },

  async list(businessId: string): Promise<BudgetRecord[]> {
    const rows = await prisma.budget.findMany({
      where: { businessId },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id, budgetNumber: row.budgetNumber,
      customerName: row.customerName, customerId: row.customerId,
      note: row.note, currency: row.currency,
      totalAmount: Number(row.totalAmount),
      status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
      items: row.items.map((item) => ({
        id: item.id, productId: item.productId, name: item.name,
        quantity: item.quantity, unitPrice: Number(item.unitPrice),
      })),
    }));
  },

  async createInTransaction(tx: Tx, args: CreateBudgetArgs): Promise<BudgetRecord> {
    const prismaTx = toPrismaTx(tx);
    const sequenceNumber = await nextSequenceNumber(prismaTx, args.businessId);
    const budgetNumber = `PRES-${String(sequenceNumber).padStart(4, "0")}`;

    const row = await prismaTx.budget.create({
      data: {
        businessId: args.businessId,
        budgetNumber,
        customerName: args.customerName,
        customerId: args.customerId,
        note: args.note,
        currency: args.currency,
        totalAmount: args.totalAmount,
        status: "draft",
        items: {
          create: args.items.map((item) => ({
            productId: item.productId,
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
      include: { items: true },
    });

    return {
      id: row.id,
      budgetNumber: row.budgetNumber,
      customerName: row.customerName,
      customerId: row.customerId,
      note: row.note,
      currency: row.currency,
      totalAmount: Number(row.totalAmount),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      items: row.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
      })),
    };
  },

  async deleteInTransaction(tx: Tx, budgetId: string, businessId: string): Promise<void> {
    const prismaTx = toPrismaTx(tx);
    // Defense-in-depth tenant guard: deleteMany scoped by both id+businessId
    // prevents cross-tenant deletion if a stale budgetId leaks through
    // upstream validation. Returns count, not row — concurrent caller is OK.
    await prismaTx.budget.deleteMany({ where: { id: budgetId, businessId } });
  },
};
