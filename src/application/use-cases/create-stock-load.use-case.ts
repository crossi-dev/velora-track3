import type { StockLoadRepositoryPort, StockLoadAuditPort, StockLoadSupplier, PurchaseRequestResult } from "@/domain/ports/stock-load.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import { assertDemoQuota, incrementDemoActionInTx, DemoLimitReachedError } from "@/app/api/_lib/demo-quota";

export interface CreateStockLoadInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  productId: string;
  itemName: string;
  supplierId: string;
  supplierName: string;
  quantity: number;
  unitPrice: number | null;
  createPurchaseRequest: boolean;
  autoCreateProduct: boolean;
  idempotencyKey: string;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
  requestBody: unknown;
}

export type CreateStockLoadOutcome =
  | "created" | "replayed" | "idempotency_missing" | "idempotency_conflict" | "idempotency_in_flight"
  | "business_not_found" | "product_not_found" | "supplier_not_found"
  | "product_not_found_auto_create_disabled" | "unit_price_required_for_new_product"
  | "product_sku_conflict" | "purchase_request_item_required"
  | "purchase_request_quantity_invalid" | "purchase_request_unit_price_invalid"
  | "demo_limit_reached";

export type CreateStockLoadResult =
  | { outcome: "created"; data: unknown }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" } | { outcome: "idempotency_conflict" } | { outcome: "idempotency_in_flight" }
  | { outcome: "business_not_found" } | { outcome: "product_not_found" } | { outcome: "supplier_not_found" }
  | { outcome: "product_not_found_auto_create_disabled" } | { outcome: "unit_price_required_for_new_product" }
  | { outcome: "product_sku_conflict" } | { outcome: "purchase_request_item_required" }
  | { outcome: "purchase_request_quantity_invalid" } | { outcome: "purchase_request_unit_price_invalid" }
  | { outcome: "demo_limit_reached"; message: string };

const DOMAIN_ERRORS: Record<string, CreateStockLoadOutcome> = {
  BUSINESS_NOT_FOUND: "business_not_found",
  PRODUCT_NOT_FOUND: "product_not_found",
  SUPPLIER_NOT_FOUND: "supplier_not_found",
  PRODUCT_NOT_FOUND_AUTO_CREATE_DISABLED: "product_not_found_auto_create_disabled",
  UNIT_PRICE_REQUIRED_FOR_NEW_PRODUCT: "unit_price_required_for_new_product",
  PRODUCT_SKU_CONFLICT: "product_sku_conflict",
  PURCHASE_REQUEST_ITEM_REQUIRED: "purchase_request_item_required",
  PURCHASE_REQUEST_QUANTITY_INVALID: "purchase_request_quantity_invalid",
  PURCHASE_REQUEST_UNIT_PRICE_INVALID: "purchase_request_unit_price_invalid",
};

interface Ports {
  stockLoad: StockLoadRepositoryPort;
  stockLoadAudit: StockLoadAuditPort;
  idempotency: IdempotencyPort;
  transaction: TransactionPort;
}

export function createStockLoadUseCase(ports: Ports) {
  return {
    async execute(input: CreateStockLoadInput): Promise<CreateStockLoadResult> {
      const { businessId, actorUserId, actorEmployeeId, productId, itemName, supplierId, supplierName, quantity, unitPrice, createPurchaseRequest, autoCreateProduct, idempotencyKey, actionMeta, requestBody } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });
      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

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

      type StockLoadAuditArgs = Parameters<typeof ports.stockLoadAudit.recordAudit>[0];
      let txResult: { responseBody: unknown; auditArgs: StockLoadAuditArgs } | null = null;

      try {
        txResult = await ports.transaction.run(async (tx) => {
          const business = await ports.stockLoad.findBusinessDetails(tx, businessId);
          if (!business) throw new Error("BUSINESS_NOT_FOUND");

          const supplier = await ports.stockLoad.resolveSupplier(tx, { businessId, supplierId, supplierName });
          const product = await ports.stockLoad.resolveProduct(tx, { businessId, productId, itemName, unitPrice, autoCreateProduct });
          const inv = await ports.stockLoad.applyInventoryUpdate(tx, { businessId, product, quantity, unitPrice });

          let request: PurchaseRequestResult | null = null;
          if (createPurchaseRequest && supplier) {
            request = await ports.stockLoad.createPurchaseRequest(tx, {
              businessId, business, supplier,
              itemName: product.name, quantity, unitPrice,
              issuedAt: inv.stockMovementCreatedAt,
            });
          }

          const rb = {
            stockLoad: {
              product: { id: product.id, name: product.name, stock: inv.quantityAfter, sku: product.sku },
              supplier: supplier as StockLoadSupplier | null,
              quantity, unitPrice, totalCost: inv.totalCost,
              cashMovementId: inv.cashMovementId,
              stockMovementId: inv.stockMovementId,
            },
            request,
          };

          await incrementDemoActionInTx(tx, businessId);
          await ports.idempotency.complete(tx, recordId, 201, rb);

          return {
            responseBody: rb,
            auditArgs: {
              actorUserId, actorEmployeeId, businessId, actionMeta,
              stockMovementId: inv.stockMovementId,
              productId: product.id, productName: product.name,
              supplierId: supplier?.id ?? null, supplierName: supplier?.name ?? null,
              cashMovementId: inv.cashMovementId,
              purchaseRequestId: request?.id ?? null,
              quantity, unitPrice, totalCost: inv.totalCost,
            },
          };
        });
      } catch (error) {
        await ports.idempotency.release(recordId);
        if (error instanceof Error && error.message in DOMAIN_ERRORS) {
          return { outcome: DOMAIN_ERRORS[error.message]! } as CreateStockLoadResult;
        }
        throw error;
      }

      // txResult is always set here: the catch block either returns or rethrows.
      // Audit write is intentionally outside the try/catch above so a failure here
      // does not trigger idempotency.release on an already-completed record.
      // Stock load is already committed — absorb audit failure.
      try {
        await ports.stockLoadAudit.recordAudit(txResult!.auditArgs); // non-null: catch always returns/rethrows
      } catch { /* audit gap — stock load committed, absorb audit failure */ }

      return { outcome: "created", data: txResult!.responseBody }; // non-null: catch always returns/rethrows
    },
  };
}
