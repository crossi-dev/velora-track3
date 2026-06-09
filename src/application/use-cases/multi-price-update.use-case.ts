import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";
import type { Prisma } from "@prisma/client";
import type { ProductRepositoryPort } from "@/domain/ports/product.repository.port";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

export interface MultiPriceUpdateItem {
  productId: string;
  price?: number;
  costPrice?: number | null;
}

export interface MultiPriceUpdateInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  items: MultiPriceUpdateItem[];
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type MultiPriceUpdateResult =
  | { outcome: "updated"; count: number; summary: string }
  | { outcome: "no_valid_items" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  product: ProductRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

// Writes only the fields explicitly provided; costPrice: null explicitly clears it.
async function applyItemInTx(
  tx: Tx,
  businessId: string,
  item: MultiPriceUpdateItem
): Promise<void> {
  const prismaTx = toPrismaTx(tx);
  const data: Prisma.ProductUpdateInput = {};
  if (item.price !== undefined) data.price = item.price;
  if ("costPrice" in item) data.costPrice = item.costPrice ?? null;
  // Scope write by id + businessId — prevents cross-tenant mutation.
  await prismaTx.product.update({
    where: { id: item.productId, businessId },
    data,
  });
}

export function multiPriceUpdateUseCase(ports: Ports) {
  return {
    async execute(input: MultiPriceUpdateInput): Promise<MultiPriceUpdateResult> {
      const {
        businessId,
        actorUserId,
        actorEmployeeId,
        items,
        idempotencyKey,
        requestBody,
        actionMeta,
      } = input;

      // At least one item must carry a price or costPrice update.
      const validItems = items.filter(
        (it) => it.price !== undefined || "costPrice" in it
      );
      if (validItems.length === 0) return { outcome: "no_valid_items" };

      const idempotency = await ports.idempotency.begin({
        businessId,
        actionType: actionMeta.actionType,
        idempotencyKey,
        requestBody,
      });

      if (idempotency.kind === "replay")
        return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      // Fetch current names for audit summary (read before the tx — no lock needed).
      const productIds = validItems.map((i) => i.productId);
      const productRows = await ports.product.fetchNamesForAudit(businessId, productIds);
      const nameMap = new Map(productRows.map((r) => [r.id, r.name]));

      try {
        await ports.transaction.run(async (tx) => {
          for (const item of validItems) {
            await applyItemInTx(tx, businessId, item);
          }
          await ports.idempotency.complete(tx, recordId, 200, { updated: validItems.length });
        });

        const summaryLines = validItems.map((item) => {
          const name = nameMap.get(item.productId) ?? item.productId;
          const parts: string[] = [];
          if (item.price !== undefined) parts.push(`price $${item.price}`);
          if ("costPrice" in item && item.costPrice !== undefined)
            parts.push(`costPrice $${item.costPrice ?? "null"}`);
          return `${name}: ${parts.join(", ")}`;
        });
        const summary = summaryLines.join("; ");

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          summary,
          payload: { productCount: validItems.length, items: validItems },
        });

        return { outcome: "updated", count: validItems.length, summary };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
