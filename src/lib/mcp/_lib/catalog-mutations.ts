// src/lib/mcp/_lib/catalog-mutations.ts — Shared constants and utilities for catalog-tools.ts.
//
// Contains: use-case instances, action metas, idempotency key builder, and errResponse helper.
// catalog-tools.ts delegates all mutations to VeloraCatalogAdapter (velora-catalog.adapter.ts);
// this file is a pure dependency-wiring module — it does NOT contain tool-handler functions.
//
// References:
//   create-product.use-case    — src/application/use-cases/create-product.use-case.ts
//   update-product.use-case    — src/application/use-cases/update-product.use-case.ts
//   create-stock-load.use-case — src/application/use-cases/create-stock-load.use-case.ts
//   SERVER_MUTATION_CONTRACT   — src/app/api/_lib/mutation-contract-entries.ts

import { createProductUseCase } from "@/application/use-cases/create-product.use-case";
import { updateProductUseCase } from "@/application/use-cases/update-product.use-case";
import { createStockLoadUseCase } from "@/application/use-cases/create-stock-load.use-case";
import { deleteProductUseCase } from "@/application/use-cases/delete-product.use-case";
import { bulkUpdateProductPricesUseCase } from "@/application/use-cases/bulk-update-product-prices.use-case";
import { prismaProductRepository } from "@/infrastructure/persistence/prisma-product.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import { prismaStockLoadRepository } from "@/infrastructure/persistence/prisma-stock-load.repository";
import { prismaStockLoadAuditAdapter } from "@/infrastructure/persistence/prisma-stock-load-audit.adapter";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
export { errResponse } from "./mcp-responses";

// ── Action metas (from canonical mutation contract) ───────────────────────────

export const PRODUCT_CREATE_ACTION = getServerActionMeta("product.create");
export const PRODUCT_UPDATE_ACTION = getServerActionMeta("product.update");
export const STOCK_LOAD_ACTION = getServerActionMeta("stock-load.create");
export const PRODUCT_DELETE_ACTION = getServerActionMeta("product.delete");
export const BULK_PRICE_UPDATE_ACTION = getServerActionMeta("product.bulk-price-update");

// Inline actionType for stock-only adjust — mirrors products/route.ts convention.
export const STOCK_ADJUST_ACTION = {
  actionType: "stock.adjust",
  routeScope: PRODUCT_UPDATE_ACTION.routeScope,
  resourceType: PRODUCT_UPDATE_ACTION.resourceType,
} as const;

// ── Use-case instances ────────────────────────────────────────────────────────

export const createProduct = createProductUseCase({
  product: prismaProductRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
});

export const updateProduct = updateProductUseCase({
  product: prismaProductRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

export const stockLoad = createStockLoadUseCase({
  stockLoad: prismaStockLoadRepository,
  stockLoadAudit: prismaStockLoadAuditAdapter,
  idempotency: prismaIdempotencyAdapter,
  transaction: prismaTransactionAdapter,
});

export const deleteProduct = deleteProductUseCase({
  product: prismaProductRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

export const bulkPriceUpdate = bulkUpdateProductPricesUseCase({
  product: prismaProductRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

// ── MCP actor constant + shared utilities ─────────────────────────────────────

export const MCP_ACTOR_USER_ID = "mcp-system";

export function mkIdemKey(businessId: string, tool: string, ...parts: (string | number | null | undefined)[]): string {
  return [businessId, tool, ...parts.map((p) => String(p ?? ""))].join(":");
}

