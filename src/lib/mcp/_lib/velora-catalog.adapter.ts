// src/lib/mcp/_lib/velora-catalog.adapter.ts — Velora concrete implementation of CatalogBackend.
//
// Wraps the use-case instances from catalog-mutations.ts. tenantId is mapped to businessId
// before every use-case call. Idempotency conflict/in-flight outcomes are surfaced as named
// Error codes so catalog-tools.ts can return agent-actionable isError responses.
//
// Design source: engine-adapter.ts / gemini-adapter.ts (composition over inheritance).

import type {
  CatalogBackend,
  CreateProductInput,
  CreateProductOutput,
  EditProductInput,
  EditProductOutput,
  StockLoadInput,
  StockLoadOutput,
  AdjustStockInput,
  AdjustStockOutput,
  DeleteProductInput,
  DeleteProductOutput,
  BulkPriceUpdateInput,
  BulkPriceUpdateOutput,
} from "./catalog-backend.port";
import {
  createProduct,
  updateProduct,
  stockLoad,
  deleteProduct,
  bulkPriceUpdate,
  MCP_ACTOR_USER_ID,
  mkIdemKey,
  PRODUCT_CREATE_ACTION,
  PRODUCT_UPDATE_ACTION,
  STOCK_LOAD_ACTION,
  STOCK_ADJUST_ACTION,
  PRODUCT_DELETE_ACTION,
  BULK_PRICE_UPDATE_ACTION,
} from "./catalog-mutations";

export class VeloraCatalogAdapter implements CatalogBackend {
  async createProduct(input: CreateProductInput): Promise<CreateProductOutput> {
    const { tenantId: businessId, name, price, costPrice, weightGrams, initialStock } = input;
    const idemKey = mkIdemKey(businessId, "create_product", name, String(price));
    const result = await createProduct.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      actorEmployeeId: null,
      name,
      price,
      costPrice: costPrice ?? null,
      weightGrams: weightGrams ?? null,
      initialStock,
      stockReason: "mcp_create",
      stockReferenceId: null,
      idempotencyKey: idemKey,
      requestBody: input,
      actionMeta: PRODUCT_CREATE_ACTION,
    });
    if (result.outcome === "replayed") {
      // Replayed responses carry the original body — pass through as-is.
      return result.body as CreateProductOutput;
    }
    if (result.outcome === "idempotency_conflict") throw new Error("IDEMPOTENCY_CONFLICT");
    if (result.outcome === "idempotency_in_flight") throw new Error("IDEMPOTENCY_IN_FLIGHT");
    if (result.outcome === "idempotency_missing") throw new Error("IDEMPOTENCY_MISSING");
    if (result.outcome !== "created") {
      throw new Error(`Unexpected outcome: ${(result as { outcome: string }).outcome}`);
    }
    const p = result.product;
    return { id: p.id, name: p.name, price: p.price, costPrice: p.costPrice, sku: p.sku, stock: p.stock };
  }

  async editProduct(input: EditProductInput): Promise<EditProductOutput> {
    const { tenantId: businessId, productId, name, price, costPrice, stockQuantity } = input;
    const hasAny = name !== undefined || price !== undefined || costPrice !== undefined || stockQuantity !== undefined;
    if (!hasAny) throw new Error("EDIT_PRODUCT_VALIDATION");

    const isStockOnly = stockQuantity !== undefined && name === undefined && price === undefined && costPrice === undefined;
    const actionMeta = isStockOnly ? STOCK_ADJUST_ACTION : PRODUCT_UPDATE_ACTION;
    // Include costPrice in the key so a cost-only update is not replayed as a no-op (Fix 4).
    const idemKey = mkIdemKey(businessId, "edit_product", productId, name, String(price ?? ""), String(costPrice ?? ""), String(stockQuantity ?? ""));
    const productUpdateData = {
      ...(name !== undefined ? { name } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(costPrice !== undefined ? { costPrice } : {}),
    };

    const result = await updateProduct.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      actorEmployeeId: null,
      productId,
      name,
      price,
      costPrice,
      stockQuantity,
      stockReason: "mcp_edit",
      stockReferenceId: null,
      productUpdateData,
      idempotencyKey: idemKey,
      requestBody: input,
      actionMeta,
    });
    if (result.outcome === "replayed") return result.body as EditProductOutput;
    if (result.outcome === "idempotency_conflict") throw new Error("IDEMPOTENCY_CONFLICT");
    if (result.outcome === "idempotency_in_flight") throw new Error("IDEMPOTENCY_IN_FLIGHT");
    if (result.outcome === "idempotency_missing") throw new Error("IDEMPOTENCY_MISSING");
    if (result.outcome !== "updated") throw new Error(`Unexpected outcome: ${(result as { outcome: string }).outcome}`);
    return { productId: result.productId, productName: result.productName, ok: true };
  }

  async stockLoad(input: StockLoadInput): Promise<StockLoadOutput> {
    const {
      tenantId: businessId,
      productId,
      itemName,
      supplierId,
      supplierName,
      quantity,
      unitPrice,
      autoCreateProduct,
      createPurchaseRequest,
    } = input;
    // Include unitPrice in the key so two loads of the same item+qty at different prices
    // are not silently deduplicated when no supplier is present (Fix 1).
    const idemKey = mkIdemKey(
      businessId,
      "stock_load",
      itemName,
      supplierId ?? supplierName,
      String(quantity),
      String(unitPrice ?? ""),
    );
    const result = await stockLoad.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      actorEmployeeId: null,
      productId: productId ?? "",
      itemName,
      supplierId: supplierId ?? "",
      supplierName: supplierName ?? "",
      quantity,
      unitPrice: unitPrice ?? null,
      createPurchaseRequest,
      autoCreateProduct,
      idempotencyKey: idemKey,
      actionMeta: STOCK_LOAD_ACTION,
      requestBody: input,
    });
    if (result.outcome === "replayed") return result.body;
    if (result.outcome === "created") {
      // When createPurchaseRequest was requested but no supplier was supplied, the use-case
      // silently skips the request (supplier is null). Surface this so the agent can inform
      // the user rather than assuming the request was created (Fix 9).
      const data = result.data as Record<string, unknown>;
      if (createPurchaseRequest && !supplierId && !supplierName && data.request === null) {
        return { ...data, requestSkipped: "no_supplier_provided" };
      }
      return result.data;
    }
    // Domain error outcomes — surface as coded Error for handler translation.
    const DOMAIN_MESSAGES: Record<string, string> = {
      product_not_found: "Product not found in this business.",
      supplier_not_found: "Supplier not found in this business.",
      product_not_found_auto_create_disabled: "Product not found. Enable autoCreateProduct or create it first.",
      unit_price_required_for_new_product: "unitPrice is required to auto-create a product.",
      business_not_found: "Business not found.",
      // Fix 3: outcomes previously falling through to "Unexpected outcome".
      product_sku_conflict: "Could not assign a unique SKU. Retry the stock load.",
      purchase_request_item_required: "An item name is required to create a purchase request.",
      purchase_request_quantity_invalid: "Quantity must be a positive integer.",
      purchase_request_unit_price_invalid: "unitPrice is required to create a purchase request.",
    };
    if (result.outcome === "idempotency_conflict") throw new Error("IDEMPOTENCY_CONFLICT");
    if (result.outcome === "idempotency_in_flight") throw new Error("IDEMPOTENCY_IN_FLIGHT");
    if (result.outcome === "idempotency_missing") throw new Error("IDEMPOTENCY_MISSING");
    const demoMsg =
      result.outcome === "demo_limit_reached"
        ? (result as { outcome: "demo_limit_reached"; message: string }).message
        : undefined;
    throw new Error(demoMsg ?? DOMAIN_MESSAGES[result.outcome] ?? `Unexpected outcome: ${result.outcome}`);
  }

  async adjustStock(input: AdjustStockInput): Promise<AdjustStockOutput> {
    const { tenantId: businessId, productId, quantity } = input;
    // Rely on updateProduct.execute → updateProductInTransaction → PRODUCT_NOT_FOUND
    // for tenant-scoped not-found handling (that path already calls findFirst with businessId).
    const idemKey = mkIdemKey(businessId, "adjust_stock", productId, "set", String(quantity));
    const result = await updateProduct.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      actorEmployeeId: null,
      productId,
      stockQuantity: quantity,
      stockReason: "mcp_adjust",
      stockReferenceId: null,
      productUpdateData: {},
      idempotencyKey: idemKey,
      requestBody: input,
      actionMeta: STOCK_ADJUST_ACTION,
    });
    if (result.outcome === "replayed") return result.body as AdjustStockOutput;
    if (result.outcome === "idempotency_conflict") throw new Error("IDEMPOTENCY_CONFLICT");
    if (result.outcome === "idempotency_in_flight") throw new Error("IDEMPOTENCY_IN_FLIGHT");
    if (result.outcome === "idempotency_missing") throw new Error("IDEMPOTENCY_MISSING");
    if (result.outcome !== "updated") throw new Error(`Unexpected outcome: ${(result as { outcome: string }).outcome}`);
    return { productId: result.productId, productName: result.productName, newStock: quantity, mode: "set", ok: true };
  }

  async deleteProduct(input: DeleteProductInput): Promise<DeleteProductOutput> {
    const { tenantId: businessId, productId } = input;
    const idemKey = mkIdemKey(businessId, "delete_product", productId);
    const result = await deleteProduct.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      actorEmployeeId: null,
      productId,
      idempotencyKey: idemKey,
      actionMeta: PRODUCT_DELETE_ACTION,
    });
    if (result.outcome === "replayed") return result.body as DeleteProductOutput;
    if (result.outcome === "not_found") throw new Error("PRODUCT_NOT_FOUND");
    if (result.outcome === "idempotency_conflict") throw new Error("IDEMPOTENCY_CONFLICT");
    if (result.outcome === "idempotency_in_flight") throw new Error("IDEMPOTENCY_IN_FLIGHT");
    if (result.outcome === "idempotency_missing") throw new Error("IDEMPOTENCY_MISSING");
    if (result.outcome !== "deleted") throw new Error(`Unexpected outcome: ${(result as { outcome: string }).outcome}`);
    return { productId, archived: result.archived, ok: true };
  }

  async bulkPriceUpdate(input: BulkPriceUpdateInput): Promise<BulkPriceUpdateOutput> {
    const { tenantId: businessId, amount, mode, direction, productIds } = input;
    // Map MCP mode/direction to the use-case's BulkPriceMode/BulkPriceDirection.
    // MCP uses "percent"/"fixed"; use-case uses "percentage"/"absolute".
    const ucMode = mode === "percent" ? "percentage" : "absolute";
    const idemKey = mkIdemKey(businessId, "bulk_price_update", String(amount), mode, direction, (productIds ?? []).join(","));
    const result = await bulkPriceUpdate.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      actorEmployeeId: null,
      amount,
      mode: ucMode,
      direction,
      productIds: productIds ?? [],
      idempotencyKey: idemKey,
      requestBody: input,
      actionMeta: BULK_PRICE_UPDATE_ACTION,
    });
    if (result.outcome === "replayed") return result.body as BulkPriceUpdateOutput;
    if (result.outcome === "no_products") throw new Error("NO_PRODUCTS_FOUND");
    if (result.outcome === "idempotency_conflict") throw new Error("IDEMPOTENCY_CONFLICT");
    if (result.outcome === "idempotency_in_flight") throw new Error("IDEMPOTENCY_IN_FLIGHT");
    if (result.outcome === "idempotency_missing") throw new Error("IDEMPOTENCY_MISSING");
    if (result.outcome !== "updated") throw new Error(`Unexpected outcome: ${(result as { outcome: string }).outcome}`);
    return { count: result.count, summary: result.summary, ok: true };
  }
}
