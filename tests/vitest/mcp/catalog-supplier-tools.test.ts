// tests/vitest/mcp/catalog-supplier-tools.test.ts
//
// Unit tests for the Batch 3 B2B-sync write tools:
//   catalog-tools.ts  : create_product, edit_product, stock_load, adjust_stock
//   supplier-tools.ts : create_supplier, create_purchase_request
//
// Uses InMemoryTransport.createLinkedPair() — mirrors the ventas-tools.test.ts style.
//
// ALL mutations go through mocked use-cases so no real DB is touched.
// Tenant-isolation tests verify that caller-supplied foreign IDs (productId, supplierId)
// result in not-found / isError rather than silently mutating another tenant's data.
//
// Pre-existing vitest failures on main (sale-post-commit-chain, employee-auth-edge)
// are unrelated — verify this file's pass count independently.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Hoisted mock factories ────────────────────────────────────────────────────

const {
  createProductExecuteMock,
  updateProductExecuteMock,
  stockLoadExecuteMock,
  createSupplierExecuteMock,
  createPurchaseRequestExecuteMock,
  prismaProductFindFirstMock,
  prismaProductFindManyMock,
} = vi.hoisted(() => ({
  createProductExecuteMock: vi.fn(),
  updateProductExecuteMock: vi.fn(),
  stockLoadExecuteMock: vi.fn(),
  createSupplierExecuteMock: vi.fn(),
  createPurchaseRequestExecuteMock: vi.fn(),
  prismaProductFindFirstMock: vi.fn(),
  prismaProductFindManyMock: vi.fn(),
}));

// ── Use-case mocks ────────────────────────────────────────────────────────────

vi.mock("@/application/use-cases/create-product.use-case", () => ({
  createProductUseCase: () => ({ execute: createProductExecuteMock }),
}));

vi.mock("@/application/use-cases/update-product.use-case", () => ({
  updateProductUseCase: () => ({ execute: updateProductExecuteMock }),
}));

vi.mock("@/application/use-cases/create-stock-load.use-case", () => ({
  createStockLoadUseCase: () => ({ execute: stockLoadExecuteMock }),
}));

vi.mock("@/application/use-cases/create-supplier.use-case", () => ({
  createSupplierUseCase: () => ({ execute: createSupplierExecuteMock }),
}));

vi.mock("@/application/use-cases/create-purchase-request.use-case", () => ({
  createPurchaseRequestUseCase: () => ({ execute: createPurchaseRequestExecuteMock }),
}));

// ── Infrastructure adapter mocks (no real DB) ─────────────────────────────────

vi.mock("@/infrastructure/persistence/prisma-product.repository", () => ({
  prismaProductRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-supplier.repository", () => ({
  prismaSupplierRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-purchase-request.repository", () => ({
  prismaPurchaseRequestRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-stock-load.repository", () => ({
  prismaStockLoadRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-stock-load-audit.adapter", () => ({
  prismaStockLoadAuditAdapter: {},
}));
vi.mock("@/infrastructure/persistence/prisma-idempotency.adapter", () => ({
  prismaIdempotencyAdapter: {},
}));
vi.mock("@/infrastructure/persistence/prisma-audit.adapter", () => ({
  prismaAuditAdapter: {},
}));
vi.mock("@/infrastructure/persistence/prisma-transaction.adapter", () => ({
  prismaTransactionAdapter: {},
}));

// ── Prisma mock (for fiscal/ventas read tools + adjust_stock tenant check) ────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findMany: prismaProductFindManyMock,
      findFirst: prismaProductFindFirstMock,
    },
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    // Stub for resolveTenantBackendMap — null = all env / "velora" defaults
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// buildActiveProductWhere passes through — scoping is tested via mock assertions.
vi.mock("@/infrastructure/shared/product-sku", () => ({
  buildActiveProductWhere: (where: Record<string, unknown>) => where,
}));

// ── Types ─────────────────────────────────────────────────────────────────────

interface TextContent { type: "text"; text: string; }
interface CallToolResult { isError?: boolean; content: TextContent[]; }
function asToolResult(raw: unknown): CallToolResult { return raw as CallToolResult; }

// ── Client helper ─────────────────────────────────────────────────────────────

async function buildConnectedClient(businessId?: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await buildVeloraMcpServer(businessId);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => { await client.close(); await server.close(); },
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("catalog + supplier tools — registration", () => {
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("registers all 6 write tools when businessId is present", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-reg-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("create_product");
      expect(names).toContain("edit_product");
      expect(names).toContain("stock_load");
      expect(names).toContain("adjust_stock");
      expect(names).toContain("create_supplier");
      expect(names).toContain("create_purchase_request");
    } finally { await cleanup(); }
  });

  it("does NOT register write tools when no businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      for (const name of ["create_product", "edit_product", "stock_load", "adjust_stock", "create_supplier", "create_purchase_request"]) {
        expect(names).not.toContain(name);
      }
    } finally { await cleanup(); }
  });
});

// ── create_product ────────────────────────────────────────────────────────────

describe("create_product tool", () => {
  const BIZ = "biz-cp-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns created product on happy path", async () => {
    createProductExecuteMock.mockResolvedValue({
      outcome: "created",
      product: { id: "prod-001", name: "Yerba 1kg", price: 1500, costPrice: 1000, sku: "YRB-01", stock: 10 },
    });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_product", arguments: { name: "Yerba 1kg", price: 1500, initialStock: 10 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { id: string; name: string; price: number };
      expect(parsed.id).toBe("prod-001");
      expect(parsed.name).toBe("Yerba 1kg");
      expect(parsed.price).toBe(1500);
    } finally { await cleanup(); }
  });

  it("returns isError on DB failure", async () => {
    createProductExecuteMock.mockRejectedValue(new Error("DB down"));
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_product", arguments: { name: "Test", price: 100 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("CREATE_PRODUCT_ERROR");
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed outcome) without error", async () => {
    createProductExecuteMock.mockResolvedValue({ outcome: "replayed", status: 201, body: { product: { id: "prod-001" } } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_product", arguments: { name: "Yerba 1kg", price: 1500 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case — not from tool input", async () => {
    createProductExecuteMock.mockResolvedValue({ outcome: "created", product: { id: "p1", name: "X", price: 100, costPrice: null, sku: null, stock: 0 } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "create_product", arguments: { name: "X", price: 100 } });
      expect(createProductExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });
});

// ── edit_product ──────────────────────────────────────────────────────────────

describe("edit_product tool", () => {
  const BIZ = "biz-ep-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns updated result on happy path", async () => {
    updateProductExecuteMock.mockResolvedValue({ outcome: "updated", productId: "prod-001", productName: "Updated" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "edit_product", arguments: { productId: "prod-001", price: 2000 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { ok: boolean };
      expect(parsed.ok).toBe(true);
    } finally { await cleanup(); }
  });

  it("returns isError when no field provided", async () => {
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "edit_product", arguments: { productId: "prod-001" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("EDIT_PRODUCT_VALIDATION");
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign productId returns PRODUCT_NOT_FOUND isError — does NOT update another tenant", async () => {
    // The use-case receives the caller-supplied productId qualified by the closure businessId.
    // Simulate the repository finding nothing (foreign ID returns null).
    updateProductExecuteMock.mockRejectedValue(new Error("PRODUCT_NOT_FOUND"));
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "edit_product", arguments: { productId: "prod-from-other-biz", price: 999 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PRODUCT_NOT_FOUND");
      // Verify the businessId from closure was sent to the use-case
      expect(updateProductExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, productId: "prod-from-other-biz" }));
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case", async () => {
    updateProductExecuteMock.mockResolvedValue({ outcome: "updated", productId: "prod-001", productName: "Name" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "edit_product", arguments: { productId: "prod-001", name: "New Name" } });
      expect(updateProductExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error", async () => {
    updateProductExecuteMock.mockResolvedValue({ outcome: "replayed", status: 200, body: { ok: true } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "edit_product", arguments: { productId: "prod-001", price: 500 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });
});

// ── stock_load ────────────────────────────────────────────────────────────────

describe("stock_load tool", () => {
  const BIZ = "biz-sl-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns created stock load on happy path", async () => {
    stockLoadExecuteMock.mockResolvedValue({
      outcome: "created",
      data: { stockLoad: { product: { id: "p1", name: "Yerba", stock: 20 }, quantity: 10, unitPrice: 800, totalCost: 8000 }, request: null },
    });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "stock_load", arguments: { itemName: "Yerba", supplierName: "Dist ABC", quantity: 10, unitPrice: 800 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("returns isError for product_not_found domain error", async () => {
    stockLoadExecuteMock.mockResolvedValue({ outcome: "product_not_found" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "stock_load", arguments: { itemName: "Nonexistent", supplierName: "Dist", quantity: 5 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
    } finally { await cleanup(); }
  });

  it("returns isError for supplier_not_found domain error", async () => {
    stockLoadExecuteMock.mockResolvedValue({ outcome: "supplier_not_found" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "stock_load", arguments: { itemName: "Yerba", supplierId: "foreign-supplier", quantity: 5 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("STOCK_LOAD_ERROR");
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case", async () => {
    stockLoadExecuteMock.mockResolvedValue({ outcome: "created", data: {} });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "stock_load", arguments: { itemName: "Yerba", supplierName: "X", quantity: 1 } });
      expect(stockLoadExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error", async () => {
    stockLoadExecuteMock.mockResolvedValue({ outcome: "replayed", status: 201, body: {} });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "stock_load", arguments: { itemName: "Yerba", supplierName: "X", quantity: 1 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });
});

// ── adjust_stock ──────────────────────────────────────────────────────────────
//
// NOTE: The pre-check against prisma.product.findFirst was removed as part of the
// CatalogBackend seam (feat/catalog-backend-seam). Tenant-scoped not-found isolation
// is now enforced by updateProductInTransaction → throws PRODUCT_NOT_FOUND when the
// product is absent or belongs to another tenant. Tests below reflect this — they
// configure updateProductExecuteMock directly rather than prismaProductFindFirstMock.

describe("adjust_stock tool", () => {
  const BIZ = "biz-as-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("sets absolute stock (mode=set) — writes the caller-supplied quantity directly", async () => {
    updateProductExecuteMock.mockResolvedValue({ outcome: "updated", productId: "prod-001", productName: "Yerba" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "adjust_stock", arguments: { productId: "prod-001", mode: "set", quantity: 50 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { newStock: number; mode: string };
      expect(parsed.newStock).toBe(50);
      expect(parsed.mode).toBe("set");
      // Verify the use-case received the absolute value, not a computed delta
      expect(updateProductExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ stockQuantity: 50 }));
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error on set", async () => {
    updateProductExecuteMock.mockResolvedValue({ outcome: "replayed", status: 200, body: { ok: true } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "adjust_stock", arguments: { productId: "prod-001", mode: "set", quantity: 50 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign productId → PRODUCT_NOT_FOUND isError — does NOT adjust another tenant", async () => {
    // Tenant isolation flows through updateProductInTransaction which calls findFirst
    // with businessId scoping and throws PRODUCT_NOT_FOUND for foreign/absent IDs.
    updateProductExecuteMock.mockRejectedValue(new Error("PRODUCT_NOT_FOUND"));
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "adjust_stock", arguments: { productId: "prod-foreign-tenant", mode: "set", quantity: 100 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PRODUCT_NOT_FOUND");
      // Verify updateProduct was called with the closure businessId
      expect(updateProductExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ, productId: "prod-foreign-tenant" }),
      );
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case (not from tool input)", async () => {
    updateProductExecuteMock.mockResolvedValue({ outcome: "updated", productId: "prod-001", productName: "Test" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "adjust_stock", arguments: { productId: "prod-001", mode: "set", quantity: 20 } });
      expect(updateProductExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ }),
      );
    } finally { await cleanup(); }
  });
});

// ── create_supplier ───────────────────────────────────────────────────────────

describe("create_supplier tool", () => {
  const BIZ = "biz-cs-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns created supplier on happy path", async () => {
    createSupplierExecuteMock.mockResolvedValue({
      outcome: "created",
      supplier: { id: "sup-001", name: "Dist ABC", phone: "123", email: null, contactName: null, leadTimeDays: 3 },
    });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_supplier", arguments: { name: "Dist ABC" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { id: string; name: string };
      expect(parsed.id).toBe("sup-001");
      expect(parsed.name).toBe("Dist ABC");
    } finally { await cleanup(); }
  });

  it("returns SUPPLIER_ALREADY_EXISTS isError when name conflicts", async () => {
    createSupplierExecuteMock.mockRejectedValue(new Error("SUPPLIER_ALREADY_EXISTS"));
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_supplier", arguments: { name: "Dist ABC" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("SUPPLIER_ALREADY_EXISTS");
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error", async () => {
    createSupplierExecuteMock.mockResolvedValue({ outcome: "replayed", status: 201, body: { supplier: { id: "sup-001" } } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_supplier", arguments: { name: "Dist ABC" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case", async () => {
    createSupplierExecuteMock.mockResolvedValue({ outcome: "created", supplier: { id: "s1", name: "X", phone: null, email: null, contactName: null, leadTimeDays: 3 } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "create_supplier", arguments: { name: "X" } });
      expect(createSupplierExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });
});

// ── create_purchase_request ───────────────────────────────────────────────────

describe("create_purchase_request tool", () => {
  const BIZ = "biz-pr-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns created request on happy path", async () => {
    createPurchaseRequestExecuteMock.mockResolvedValue({
      outcome: "created",
      request: { id: "req-001", requestNumber: "OC-001" },
    });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_purchase_request", arguments: { supplierId: "sup-001", itemName: "Yerba", quantity: 100, unitPrice: 1200 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { id: string; requestNumber: string };
      expect(parsed.id).toBe("req-001");
      expect(parsed.requestNumber).toBe("OC-001");
    } finally { await cleanup(); }
  });

  it("returns validation isError when neither supplierId nor supplierName provided", async () => {
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_purchase_request", arguments: { itemName: "Yerba", quantity: 10, unitPrice: 500 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("VALIDATION_ERROR");
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign supplierId (throws SUPPLIER_NOT_FOUND) → isError — does NOT create for another tenant", async () => {
    // The repository's createInTransaction uses throwOnSupplierIdMiss=true + businessId scoping.
    // Simulate the tenant-scoped lookup returning nothing for a foreign supplierId.
    createPurchaseRequestExecuteMock.mockRejectedValue(new Error("SUPPLIER_NOT_FOUND"));
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_purchase_request", arguments: { supplierId: "sup-foreign-tenant", itemName: "Item", quantity: 1, unitPrice: 100 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("SUPPLIER_NOT_FOUND");
      // Verify closure businessId was passed
      expect(createPurchaseRequestExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ, supplierId: "sup-foreign-tenant" }),
      );
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error", async () => {
    createPurchaseRequestExecuteMock.mockResolvedValue({ outcome: "replayed", status: 201, body: { request: { id: "req-001" } } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "create_purchase_request", arguments: { supplierName: "X", itemName: "Y", quantity: 1, unitPrice: 100 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case — not from tool input", async () => {
    createPurchaseRequestExecuteMock.mockResolvedValue({ outcome: "created", request: { id: "r1", requestNumber: "OC-001" } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "create_purchase_request", arguments: { supplierName: "Dist", itemName: "Item", quantity: 5, unitPrice: 100 } });
      expect(createPurchaseRequestExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });
});
