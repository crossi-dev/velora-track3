import type { BusinessRepositoryPort } from "@/domain/ports/business.repository.port";
import type { SaleRepositoryPort, CheckedSaleItem, CreateSaleTransactionResult } from "@/domain/ports/sale.repository.port";
import type { InventoryRepositoryPort } from "@/domain/ports/inventory.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { ActorRole } from "@/domain";
import { cloudLog } from "@/lib/cloud-logger";
import {
  InsufficientStockError,
  PriceOutlierError,
  ProductNotOwnedError,
  BusinessNotFoundError,
  CustomerNotFoundError,
  InvalidItemQuantityError,
  SaleDateFutureError,
} from "@/domain/errors";
import { validateSaleItemQuantity, detectPriceOutlier, DEFAULT_PRICE_OUTLIER_THRESHOLD } from "@/domain/rules";
import { assertDemoQuota, incrementDemoActionInTx, DemoLimitReachedError } from "@/app/api/_lib/demo-quota";
import { sumLineItems } from "@/lib/money";

export interface CreateSaleInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  actorRole: ActorRole;
  customerId: string | null;
  items: Array<{ productId: string; quantity: number; unitPrice: number }>;
  fallbackCustomerName: string;
  normalizedFallbackCustomerName: string;
  idempotencyKey: string;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
  requestBody: unknown;
  // Optional payment method — defaults to "efectivo" when absent.
  paymentMethod?: string | null;
  // Optional explicit sale date. When provided, must not exceed now + 1 minute
  // (prevents far-future backdating). Absent → DB default (now()).
  saleDate?: Date | null;
}

export type CreateSaleResult =
  | { outcome: "created"; data: CreateSaleTransactionResult }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" }
  | { outcome: "business_not_found" }
  | { outcome: "entity_deleted"; missing: string[] }
  | { outcome: "customer_not_found" }
  | { outcome: "invalid_item_quantity" }
  | { outcome: "sale_date_future" }
  | { outcome: "product_not_owned" }
  | { outcome: "insufficient_stock"; productName: string; available: number }
  | { outcome: "price_outlier"; productId: string; direction: "above" | "below"; expected: number }
  | { outcome: "demo_limit_reached"; message: string };

interface Ports {
  business: BusinessRepositoryPort;
  sale: SaleRepositoryPort;
  inventory: InventoryRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}


export function createSaleUseCase(ports: Ports) {
  return {
    async execute(input: CreateSaleInput): Promise<CreateSaleResult> {
      const { businessId, actorUserId, actorEmployeeId, actorRole, customerId,
        items, fallbackCustomerName, normalizedFallbackCustomerName,
        idempotencyKey, actionMeta, requestBody, paymentMethod, saleDate } = input;

      // Guard: explicit saleDate must not be more than 1 minute in the future.
      // The DB default (now()) is always fine; this only fires when a caller passes saleDate.
      if (saleDate != null && saleDate.getTime() > Date.now() + 60_000) {
        return { outcome: "sale_date_future" };
      }

      // Idempotency guard runs first so a client retry after the sale is already committed
      // (but the product was later deleted) gets a clean "replayed" response instead of
      // a misleading "entity_deleted" outcome.
      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });
      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      const business = await ports.business.findById(businessId);
      if (!business) {
        await ports.idempotency.release(recordId);
        return { outcome: "business_not_found" };
      }

      const productIds = items.map(i => i.productId).filter(id => id.trim());
      const uniqueProductIds = Array.from(new Set(productIds));
      const missing = await ports.sale.checkEntitiesExist(businessId, uniqueProductIds, customerId);
      if (missing.length > 0) {
        await ports.idempotency.release(recordId);
        return { outcome: "entity_deleted", missing };
      }

      // Quota checked after begin so replays of already-counted actions are never blocked.
      try {
        await assertDemoQuota(businessId);
      } catch (e) {
        if (e instanceof DemoLimitReachedError) {
          await ports.idempotency.release(recordId);
          return { outcome: "demo_limit_reached", message: e.message };
        }
        throw e;
      }

      try {
        const txResult = await ports.transaction.run(async (tx) => {
          const inventoryRecords = await ports.inventory.loadForProducts(tx, productIds, businessId);
          const inventoryMap = new Map(inventoryRecords.map(r => [r.productId, r]));

          const checkedItems: CheckedSaleItem[] = [];
          for (const item of items) {
            if (validateSaleItemQuantity(item.quantity)) throw new InvalidItemQuantityError();
            const inv = inventoryMap.get(item.productId);
            if (!inv || inv.product.businessId !== businessId) throw new ProductNotOwnedError();
            if (actorRole === "employee") {
              const outlier = detectPriceOutlier(item.unitPrice, inv.product.price, DEFAULT_PRICE_OUTLIER_THRESHOLD);
              if (outlier) throw new PriceOutlierError(item.productId, outlier.direction, outlier.expected);
            } else {
              // Owner path: soft price-integrity check (defense-in-depth).
              //
              // The primary guard is guardSaleUnitPrice in supervisor-action-mapper.money-guard.ts,
              // which strips LLM-invented unitPrice values before they reach this use-case when
              // the owner did not explicitly type the price. This check is a secondary layer that
              // fires ONLY when a price that deviates > 50% from catalog actually reaches commit
              // (i.e. the mapper's token-match passed or the saleDraft path was used).
              //
              // We log a WARNING and proceed — owner-set prices are legitimate business overrides
              // (e.g. bulk discounts, promotional pricing). We do NOT throw PriceOutlierError here
              // because that would hard-block a real owner override. The confirmation modal shown
              // before commit is the user-facing backstop.
              const outlier = detectPriceOutlier(item.unitPrice, inv.product.price, DEFAULT_PRICE_OUTLIER_THRESHOLD);
              if (outlier) {
                cloudLog({
                  severity: "WARNING",
                  component: "SaleExecutor",
                  action: "OWNER_PRICE_OUTLIER",
                  a2a_transfer: false,
                  message: "Owner sale: unitPrice deviates > 50% from catalog — possible LLM-fabricated price slipped past mapper guard",
                  businessId,
                  data: {
                    productId: item.productId,
                    unitPrice: item.unitPrice,
                    catalogPrice: outlier.expected,
                    direction: outlier.direction,
                  },
                });
              }
            }
            checkedItems.push({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice, productName: inv.product.name, unitCost: inv.product.costPrice });
          }

          // sumLineItems uses Prisma.Decimal (decimal.js) → exact ROUND_HALF_UP.
          // Convert to number at the boundary: downstream sale-transaction.ts
          // accepts number and Prisma writes it as Decimal to the DB column.
          // Source: https://mikemcl.github.io/decimal.js/ (VERIFIED HTTP 200)
          const serverTotal = sumLineItems(checkedItems).toNumber();

          const result = await ports.sale.createTransaction(tx, {
            businessId, customerId, employeeId: actorEmployeeId, fallbackCustomerName, normalizedFallbackCustomerName,
            checkedItems, serverTotal, allowNegativeStock: business.allowNegativeStock,
            paymentMethod: paymentMethod ?? "efectivo",
          });

          await incrementDemoActionInTx(tx, businessId);

          return result;
        });

        // Idempotency completion runs OUTSIDE the transaction. If we kept it
        // inside and the tx commit succeeded but the completion write failed
        // afterwards (connection blip), the record stays "pending" and a
        // client retry would re-execute the sale. Outside the tx, a failed
        // completion only means the row stays pending until TTL prune, while
        // the retry hits the unique-key constraint and falls back to replay.
        try {
          await ports.idempotency.complete(null, recordId, 201, txResult.idempotencyResponseBody);
        } catch (idemErr) {
          // Best-effort: TTL prune (5 min) cleans stuck pending rows; the
          // unique-key still arbitrates retries during the gap.
          cloudLog({
            severity: "WARNING",
            component: "SaleExecutor",
            action: "IDEMPOTENCY_COMPLETE_FAILED",
            a2a_transfer: false,
            message: "idempotency.complete failed post-commit — row stays pending until TTL prune",
            businessId,
            data: { error: idemErr instanceof Error ? idemErr.message : String(idemErr) },
          });
        }

        // audit gap: sale already committed — absorb write failure
        try {
          await ports.audit.recordCriticalWrite({
            businessId, actorUserId, actorEmployeeId,
            routeScope: actionMeta.routeScope, actionType: actionMeta.actionType, resourceType: actionMeta.resourceType,
            resourceId: txResult.sale.id,
            summary: `Venta registrada — ${txResult.auditMeta.invoiceNumber} — ${txResult.auditMeta.customerName}`,
            payload: {
              saleId: txResult.sale.id, invoiceId: txResult.auditMeta.invoiceId,
              invoiceNumber: txResult.auditMeta.invoiceNumber, customerId: txResult.auditMeta.customerId,
              customerName: txResult.auditMeta.customerName, totalAmount: txResult.auditMeta.totalAmount,
              itemCount: txResult.auditMeta.itemCount, lowStockAlertCount: txResult.lowStockAlerts.length,
            },
            input: { customerId, items },
            after: { saleId: txResult.sale.id, totalAmount: txResult.sale.totalAmount, invoiceNumber: txResult.auditMeta.invoiceNumber },
          });
        } catch (auditErr) {
          cloudLog({
            severity: "WARNING",
            component: "SaleExecutor",
            action: "AUDIT_WRITE_FAILED_POST_COMMIT",
            a2a_transfer: false,
            message: "CriticalWriteEvent record failed post-commit — sale is committed, audit trail incomplete",
            businessId,
            data: { error: auditErr instanceof Error ? auditErr.message : String(auditErr) },
          });
        }

        return { outcome: "created", data: txResult };
      } catch (error) {
        await ports.idempotency.release(recordId);
        if (error instanceof InvalidItemQuantityError) return { outcome: "invalid_item_quantity" };
        if (error instanceof ProductNotOwnedError) return { outcome: "product_not_owned" };
        if (error instanceof PriceOutlierError) return { outcome: "price_outlier", productId: error.productId, direction: error.direction, expected: error.expected };
        if (error instanceof InsufficientStockError) return { outcome: "insufficient_stock", productName: error.productName, available: error.available };
        if (error instanceof CustomerNotFoundError) return { outcome: "customer_not_found" };
        if (error instanceof BusinessNotFoundError) return { outcome: "business_not_found" };
        throw error;
      }
    },
  };
}
