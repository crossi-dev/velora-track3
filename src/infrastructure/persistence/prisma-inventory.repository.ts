import type { Tx } from "@/domain/ports/tx";
import type { InventoryRepositoryPort, InventoryRecord } from "@/domain/ports/inventory.repository.port";
import { loadInventoryRecords } from "@/infrastructure/shared/sale-inventory";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

export const prismaInventoryRepository: InventoryRepositoryPort = {
  async loadForProducts(tx: Tx, productIds: string[], businessId: string): Promise<InventoryRecord[]> {
    const prismaTx = toPrismaTx(tx);
    return loadInventoryRecords(prismaTx, productIds, businessId);
  },
};
