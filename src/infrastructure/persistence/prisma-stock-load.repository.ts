import type {
  StockLoadRepositoryPort,
  BusinessDetails,
  StockLoadSupplier,
  ResolvedProduct,
  InventoryUpdateResult,
  PurchaseRequestResult,
  ResolveSupplierParams,
  ResolveProductParams,
  ApplyInventoryParams,
  CreatePurchaseRequestParams,
} from "@/domain/ports/stock-load.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { resolveStockLoadSupplier } from "@/app/api/stock-loads/_lib/stock-load-supplier";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";
import { resolveStockLoadProduct, applyStockLoadInventoryUpdate } from "@/app/api/stock-loads/_lib/stock-load-products";
import { createPurchaseRequestInTransaction, normalizePurchaseRequestCreateInput } from "@/app/api/_lib/purchase-request-creation";

export const prismaStockLoadRepository: StockLoadRepositoryPort = {
  async findBusinessDetails(tx: Tx, businessId: string): Promise<BusinessDetails | null> {
    const prismaTx = toPrismaTx(tx);
    const row = await prismaTx.business.findUnique({
      where: { id: businessId },
      select: { name: true, currency: true, cuit: true, address: true },
    });
    if (!row) return null;
    return { name: row.name, currency: row.currency, cuit: row.cuit ?? null, address: row.address ?? null };
  },

  async resolveSupplier(tx: Tx, params: ResolveSupplierParams): Promise<StockLoadSupplier | null> {
    const prismaTx = toPrismaTx(tx);
    // Normalize optional fields to empty string — resolveStockLoadSupplier handles empty strings
    // as "no supplier" (returns null when both are empty).
    return resolveStockLoadSupplier(prismaTx, {
      businessId: params.businessId,
      supplierId: params.supplierId ?? "",
      supplierName: params.supplierName ?? "",
    });
  },

  async resolveProduct(tx: Tx, params: ResolveProductParams): Promise<ResolvedProduct> {
    const prismaTx = toPrismaTx(tx);
    const row = await resolveStockLoadProduct(prismaTx, params);
    return { id: row.id, name: row.name, price: Number(row.price), sku: row.sku, currentQuantity: row.currentQuantity };
  },

  async applyInventoryUpdate(tx: Tx, params: ApplyInventoryParams): Promise<InventoryUpdateResult> {
    const prismaTx = toPrismaTx(tx);
    const r = await applyStockLoadInventoryUpdate(prismaTx, { businessId: params.businessId, product: params.product, quantity: params.quantity, unitPrice: params.unitPrice });
    return {
      stockMovementId: r.stockMovement.id,
      stockMovementCreatedAt: r.stockMovement.createdAt,
      quantityAfter: r.quantityAfter,
      totalCost: r.totalCost,
      cashMovementId: r.cashMovementId,
    };
  },

  async createPurchaseRequest(tx: Tx, params: CreatePurchaseRequestParams): Promise<PurchaseRequestResult> {
    const prismaTx = toPrismaTx(tx);
    const input = normalizePurchaseRequestCreateInput({ itemName: params.itemName, quantity: params.quantity, unitPrice: params.unitPrice });
    const { request } = await createPurchaseRequestInTransaction(prismaTx, {
      businessId: params.businessId,
      business: params.business,
      supplier: params.supplier,
      input,
      issuedAt: params.issuedAt,
    });
    return { id: request.id, requestNumber: request.requestNumber, issuedAt: request.issuedAt, currency: request.currency, totalAmount: request.totalAmount, payload: request.payload };
  },
};
