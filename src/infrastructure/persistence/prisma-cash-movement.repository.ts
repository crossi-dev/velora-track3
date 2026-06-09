import type { CashMovementRepositoryPort, CreateCashMovementArgs, CashMovementRecord } from "@/domain/ports/cash-movement.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { createCashMovementInTransaction } from "@/infrastructure/shared/cash-mutations";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

export const prismaCashMovementRepository: CashMovementRepositoryPort = {
  async createInTransaction(tx: Tx, args: CreateCashMovementArgs): Promise<CashMovementRecord> {
    const prismaTx = toPrismaTx(tx);
    const row = await createCashMovementInTransaction(prismaTx, args);
    return {
      id: row.id,
      type: row.type,
      description: row.description,
      amount: Number(row.amount),
      date: row.date,
      saleId: row.saleId ?? null,
      clientMessageId: row.clientMessageId ?? null,
    };
  },
};
