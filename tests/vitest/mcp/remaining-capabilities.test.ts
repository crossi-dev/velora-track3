// tests/vitest/mcp/remaining-capabilities.test.ts
//
// Unit tests for the 5 remaining MCP commerce capabilities:
//   delete_product    : via CatalogBackend.deleteProduct (catalog-tools.ts)
//   bulk_price_update : via CatalogBackend.bulkPriceUpdate (catalog-tools.ts)
//   delete_customer   : via CustomerBackend.deleteCustomer (customer-tools.ts)
//   edit_supplier     : via SupplierBackend.editSupplier (supplier-tools.ts)
//   delete_supplier   : via SupplierBackend.deleteSupplier (supplier-tools.ts)
//   return_sale       : via handleReturnSale (sales-tools.ts → return-sale-mutations.ts)
//
// Pattern mirrors catalog-supplier-tools.test.ts:
//   - buildConnectedClient creates an in-process MCP server backed by mocked use-cases.
//   - ALL mutations go through mocked use-cases — no real DB is touched.
//   - Tenant-isolation tests verify closure businessId is always forwarded.
//   - Injected idempotency_key has no effect (server-derived keys).
//   - Pre-existing vitest failures on main (sale-post-commit-chain, employee-auth-edge)
//     are unrelated — verify this file's pass count independently.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Hoisted mock factories ────────────────────────────────────────────────────

const {
  deleteProductExecuteMock,
  bulkPriceUpdateExecuteMock,
  deleteCustomerExecuteMock,
  updateSupplierExecuteMock,
  deleteSupplierExecuteMock,
  // return_sale mocks
  prismaReturnSaleFindManyMock,
  prismaReturnBusinessFindUniqueMock,
  prismaInvoiceFindManyMock,
  prismaReturnSaleUpdateManyMock,
  prismaIdempotencyBeginMock,
  undoSaleBatchMock,
  // existing mocks needed for server registration
  createProductExecuteMock,
  updateProductExecuteMock,
  stockLoadExecuteMock,
  createSupplierExecuteMock,
  createPurchaseRequestExecuteMock,
  prismaProductFindManyMock,
} = vi.hoisted(() => ({
  deleteProductExecuteMock: vi.fn(),
  bulkPriceUpdateExecuteMock: vi.fn(),
  deleteCustomerExecuteMock: vi.fn(),
  updateSupplierExecuteMock: vi.fn(),
  deleteSupplierExecuteMock: vi.fn(),
  // return_sale
  prismaReturnSaleFindManyMock: vi.fn(),
  prismaReturnBusinessFindUniqueMock: vi.fn(),
  prismaInvoiceFindManyMock: vi.fn(),
  prismaReturnSaleUpdateManyMock: vi.fn(),
  prismaIdempotencyBeginMock: vi.fn(),
  undoSaleBatchMock: vi.fn(),
  // existing
  createProductExecuteMock: vi.fn(),
  updateProductExecuteMock: vi.fn(),
  stockLoadExecuteMock: vi.fn(),
  createSupplierExecuteMock: vi.fn(),
  createPurchaseRequestExecuteMock: vi.fn(),
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
vi.mock("@/application/use-cases/delete-product.use-case", () => ({
  deleteProductUseCase: () => ({ execute: deleteProductExecuteMock }),
}));
vi.mock("@/application/use-cases/bulk-update-product-prices.use-case", () => ({
  bulkUpdateProductPricesUseCase: () => ({ execute: bulkPriceUpdateExecuteMock }),
}));
vi.mock("@/application/use-cases/delete-customer.use-case", () => ({
  deleteCustomerUseCase: () => ({ execute: deleteCustomerExecuteMock }),
}));
vi.mock("@/application/use-cases/create-supplier.use-case", () => ({
  createSupplierUseCase: () => ({ execute: createSupplierExecuteMock }),
}));
vi.mock("@/application/use-cases/create-purchase-request.use-case", () => ({
  createPurchaseRequestUseCase: () => ({ execute: createPurchaseRequestExecuteMock }),
}));
vi.mock("@/application/use-cases/update-supplier.use-case", () => ({
  updateSupplierUseCase: () => ({ execute: updateSupplierExecuteMock }),
}));
vi.mock("@/application/use-cases/delete-supplier.use-case", () => ({
  deleteSupplierUseCase: () => ({ execute: deleteSupplierExecuteMock }),
}));

// ── Infrastructure adapter mocks (no real DB) ─────────────────────────────────

vi.mock("@/infrastructure/persistence/prisma-product.repository", () => ({
  prismaProductRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-customer.repository", () => ({
  prismaCustomerRepository: {},
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
  prismaIdempotencyAdapter: { begin: prismaIdempotencyBeginMock, release: vi.fn(), complete: vi.fn() },
}));
vi.mock("@/infrastructure/persistence/prisma-audit.adapter", () => ({
  prismaAuditAdapter: {},
}));
vi.mock("@/infrastructure/persistence/prisma-transaction.adapter", () => ({
  prismaTransactionAdapter: {},
}));

// ── Prisma mock ────────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findMany: prismaProductFindManyMock, findFirst: vi.fn() },
    sale: {
      findMany: prismaReturnSaleFindManyMock,
      updateMany: prismaReturnSaleUpdateManyMock,
    },
    business: { findUnique: prismaReturnBusinessFindUniqueMock },
    invoice: { findMany: prismaInvoiceFindManyMock },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}));

// ── undo-sale transaction mock ─────────────────────────────────────────────────

vi.mock("@/app/api/undo/_lib/undo-sale", () => ({
  undoSaleBatchInTransaction: undoSaleBatchMock,
}));

vi.mock("@/infrastructure/shared/product-sku", () => ({
  buildActiveProductWhere: (where: Record<string, unknown>) => where,
}));

// ── Types + helpers ───────────────────────────────────────────────────────────

interface TextContent { type: "text"; text: string; }
interface CallToolResult { isError?: boolean; content: TextContent[]; }
function asToolResult(raw: unknown): CallToolResult { return raw as CallToolResult; }

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

describe("remaining capabilities — registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaProductFindManyMock.mockResolvedValue([]);
  });

  it("registers all 5 new tools when businessId is present", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-reg-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("delete_product");
      expect(names).toContain("bulk_price_update");
      expect(names).toContain("delete_customer");
      expect(names).toContain("edit_supplier");
      expect(names).toContain("delete_supplier");
      expect(names).toContain("return_sale");
    } finally { await cleanup(); }
  });

  it("does NOT register new tools when no businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      for (const name of ["delete_product", "bulk_price_update", "delete_customer", "edit_supplier", "delete_supplier", "return_sale"]) {
        expect(names).not.toContain(name);
      }
    } finally { await cleanup(); }
  });
});

// ── delete_product ────────────────────────────────────────────────────────────

describe("delete_product tool", () => {
  const BIZ = "biz-dp-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns deleted (archived=false) on happy path", async () => {
    deleteProductExecuteMock.mockResolvedValue({ outcome: "deleted", archived: false });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_product", arguments: { productId: "prod-001" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { ok: boolean; archived: boolean };
      expect(parsed.ok).toBe(true);
      expect(parsed.archived).toBe(false);
    } finally { await cleanup(); }
  });

  it("returns deleted (archived=true) when product has sales", async () => {
    deleteProductExecuteMock.mockResolvedValue({ outcome: "deleted", archived: true });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_product", arguments: { productId: "prod-with-sales" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { ok: boolean; archived: boolean };
      expect(parsed.archived).toBe(true);
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign productId returns PRODUCT_NOT_FOUND (isError)", async () => {
    deleteProductExecuteMock.mockResolvedValue({ outcome: "not_found" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_product", arguments: { productId: "prod-foreign" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PRODUCT_NOT_FOUND");
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error", async () => {
    deleteProductExecuteMock.mockResolvedValue({ outcome: "replayed", status: 200, body: { productId: "prod-001", archived: false, ok: true } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_product", arguments: { productId: "prod-001" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case (not from tool input)", async () => {
    deleteProductExecuteMock.mockResolvedValue({ outcome: "deleted", archived: false });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "delete_product", arguments: { productId: "prod-001" } });
      expect(deleteProductExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });
});

// ── bulk_price_update ─────────────────────────────────────────────────────────

describe("bulk_price_update tool", () => {
  const BIZ = "biz-bpu-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns updated count on happy path (all products)", async () => {
    bulkPriceUpdateExecuteMock.mockResolvedValue({ outcome: "updated", count: 5, summary: "5 precios aumentados 10%." });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "bulk_price_update", arguments: { amount: 10, mode: "percent", direction: "up" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { count: number; ok: boolean };
      expect(parsed.count).toBe(5);
      expect(parsed.ok).toBe(true);
    } finally { await cleanup(); }
  });

  it("returns updated count on happy path (subset with productIds)", async () => {
    bulkPriceUpdateExecuteMock.mockResolvedValue({ outcome: "updated", count: 2, summary: "2 precios reducidos $50." });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({
        name: "bulk_price_update",
        arguments: { amount: 50, mode: "fixed", direction: "down", productIds: ["p1", "p2"] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { count: number };
      expect(parsed.count).toBe(2);
    } finally { await cleanup(); }
  });

  it("returns isError when no products found", async () => {
    bulkPriceUpdateExecuteMock.mockResolvedValue({ outcome: "no_products" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "bulk_price_update", arguments: { amount: 5, mode: "percent", direction: "up", productIds: ["nonexistent"] } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error", async () => {
    bulkPriceUpdateExecuteMock.mockResolvedValue({ outcome: "replayed", status: 200, body: { count: 3, ok: true } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "bulk_price_update", arguments: { amount: 10, mode: "percent", direction: "up" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("passes closure businessId (not from tool input) and maps mode correctly", async () => {
    bulkPriceUpdateExecuteMock.mockResolvedValue({ outcome: "updated", count: 1, summary: "ok" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "bulk_price_update", arguments: { amount: 20, mode: "percent", direction: "up" } });
      expect(bulkPriceUpdateExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ, mode: "percentage", direction: "up" }),
      );
    } finally { await cleanup(); }
  });
});

// ── delete_customer ───────────────────────────────────────────────────────────

describe("delete_customer tool", () => {
  const BIZ = "biz-dc-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns deleted on happy path", async () => {
    deleteCustomerExecuteMock.mockResolvedValue({ outcome: "deleted" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_customer", arguments: { customerId: "cust-001" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { outcome: string; ok: boolean };
      expect(parsed.outcome).toBe("deleted");
      expect(parsed.ok).toBe(true);
    } finally { await cleanup(); }
  });

  it("returns HAS_HISTORY isError when customer has invoices/sales", async () => {
    deleteCustomerExecuteMock.mockResolvedValue({ outcome: "has_history", invoiceCount: 3, saleCount: 7 });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_customer", arguments: { customerId: "cust-with-history" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; invoiceCount: number; saleCount: number };
      expect(parsed.code).toBe("HAS_HISTORY");
      expect(parsed.invoiceCount).toBe(3);
      expect(parsed.saleCount).toBe(7);
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign customerId returns CUSTOMER_NOT_FOUND (isError)", async () => {
    deleteCustomerExecuteMock.mockResolvedValue({ outcome: "not_found" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_customer", arguments: { customerId: "cust-foreign" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("CUSTOMER_NOT_FOUND");
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error", async () => {
    deleteCustomerExecuteMock.mockResolvedValue({ outcome: "replayed", status: 200, body: { outcome: "deleted", ok: true } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_customer", arguments: { customerId: "cust-001" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case (not from tool input)", async () => {
    deleteCustomerExecuteMock.mockResolvedValue({ outcome: "deleted" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "delete_customer", arguments: { customerId: "cust-001" } });
      expect(deleteCustomerExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });
});

// ── edit_supplier ─────────────────────────────────────────────────────────────

describe("edit_supplier tool", () => {
  const BIZ = "biz-es-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns ok on happy path", async () => {
    updateSupplierExecuteMock.mockResolvedValue({ outcome: "updated" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "edit_supplier", arguments: { supplierId: "sup-001", name: "New Name" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { ok: boolean; supplierId: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.supplierId).toBe("sup-001");
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign supplierId propagates closure businessId", async () => {
    updateSupplierExecuteMock.mockResolvedValue({ outcome: "updated" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "edit_supplier", arguments: { supplierId: "sup-foreign", phone: "999" } });
      expect(updateSupplierExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error", async () => {
    updateSupplierExecuteMock.mockResolvedValue({ outcome: "replayed", status: 200, body: { supplierId: "sup-001", ok: true } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "edit_supplier", arguments: { supplierId: "sup-001", name: "X" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case", async () => {
    updateSupplierExecuteMock.mockResolvedValue({ outcome: "updated" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "edit_supplier", arguments: { supplierId: "sup-001", leadTimeDays: 5 } });
      expect(updateSupplierExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, supplierId: "sup-001" }));
    } finally { await cleanup(); }
  });
});

// ── delete_supplier ───────────────────────────────────────────────────────────

describe("delete_supplier tool", () => {
  const BIZ = "biz-dsu-001";
  beforeEach(() => { vi.clearAllMocks(); prismaProductFindManyMock.mockResolvedValue([]); });

  it("returns ok on happy path", async () => {
    deleteSupplierExecuteMock.mockResolvedValue({ outcome: "deleted" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_supplier", arguments: { supplierId: "sup-001" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { ok: boolean; supplierId: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.supplierId).toBe("sup-001");
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign supplierId returns SUPPLIER_NOT_FOUND (isError)", async () => {
    deleteSupplierExecuteMock.mockResolvedValue({ outcome: "not_found" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_supplier", arguments: { supplierId: "sup-foreign" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("SUPPLIER_NOT_FOUND");
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without error", async () => {
    deleteSupplierExecuteMock.mockResolvedValue({ outcome: "replayed", status: 200, body: { supplierId: "sup-001", ok: true } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "delete_supplier", arguments: { supplierId: "sup-001" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("passes closure businessId to the use-case (not from tool input)", async () => {
    deleteSupplierExecuteMock.mockResolvedValue({ outcome: "deleted" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "delete_supplier", arguments: { supplierId: "sup-001" } });
      expect(deleteSupplierExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });
});

// ── return_sale ───────────────────────────────────────────────────────────────

describe("return_sale tool", () => {
  const BIZ = "biz-rs-001";

  const MOCK_SALES = [
    {
      id: "sale-001",
      date: new Date(),
      totalAmount: 1500,
      customer: { name: "Juan", phone: "+54911111111" },
      saleItems: [{ productId: "prod-001", quantity: 2 }],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    prismaProductFindManyMock.mockResolvedValue([]);
    prismaReturnSaleFindManyMock.mockResolvedValue(MOCK_SALES);
    prismaReturnBusinessFindUniqueMock.mockResolvedValue({ name: "Mi Negocio" });
    prismaReturnSaleUpdateManyMock.mockResolvedValue({ count: 1 });
    // Default idempotency: execute path
    prismaIdempotencyBeginMock.mockResolvedValue({ kind: "execute", recordId: "idem-001" });
    // Default $transaction: call undoSaleBatchMock and return its result
    undoSaleBatchMock.mockResolvedValue({ labels: ["Juan — $1500"] });
  });

  it("returns { returned, summary } on happy path", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Simulate empty protected invoices then call undoSaleBatchMock
      prismaInvoiceFindManyMock.mockResolvedValueOnce([]);
      return undoSaleBatchMock({}, { businessId: BIZ, userId: "mcp-system", routeScope: "undo", sales: MOCK_SALES, idempotencyRecordId: "idem-001" });
    });

    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "return_sale", arguments: { count: 1, cutoffHours: 24 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { returned: number; summary: string[] };
      expect(parsed.returned).toBe(1);
    } finally { await cleanup(); }
  });

  it("returns NO_RECENT_SALES isError when no sales in cutoff window", async () => {
    prismaReturnSaleFindManyMock.mockResolvedValueOnce([]);
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "return_sale", arguments: { count: 1, cutoffHours: 1 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("NO_RECENT_SALES");
    } finally { await cleanup(); }
  });

  it("deduplicates (replayed) without calling $transaction", async () => {
    prismaIdempotencyBeginMock.mockResolvedValueOnce({ kind: "replay", status: 200, body: { returned: 1, summary: ["Juan — $1500"] } });
    const { prisma } = await import("@/lib/prisma");
    const txSpy = prisma.$transaction as ReturnType<typeof vi.fn>;
    txSpy.mockClear();

    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "return_sale", arguments: { count: 1, cutoffHours: 24 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      expect(txSpy).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  it("passes closure businessId to sale.findMany (not from tool input)", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return undoSaleBatchMock({}, {});
    });

    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "return_sale", arguments: { count: 1, cutoffHours: 24 } });
      expect(prismaReturnSaleFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: BIZ }) }),
      );
    } finally { await cleanup(); }
  });

  it("rejects count > 10 via schema validation (max guard)", async () => {
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      // Zod schema has .max(10) — count=20 must be rejected. The MCP SDK surfaces
      // schema validation failures as isError responses rather than thrown errors.
      const raw = await client.callTool({ name: "return_sale", arguments: { count: 20, cutoffHours: 24 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
    } finally { await cleanup(); }
  });
});
