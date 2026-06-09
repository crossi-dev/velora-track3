// tests/vitest/mcp/inventario-port-delegation.test.ts
//
// Verifies that the inventario ADK read tools (stock.consultar_stock filter=low_stock
// and stock.gestionar_stock action=stocktake) delegate to VentasBackend port
// methods instead of calling prisma directly.
//
// Tests mirror caja-tools.test.ts Part B style:
//   (b1) consultar_stock low_stock: calls ventasBackend.getLowStockProducts, NOT prisma
//   (b2) gestionar_stock stocktake: calls ventasBackend.getProductStock, NOT prisma
//   (b3) getLowStockProducts returns empty → correct "sin stock bajo" response
//   (b4) getProductStock returns null → PRODUCT_NOT_FOUND error
//   (b5) stocktake with zero variance → no-op message, no intent emitted
//   (b6) gestionar_stock load/adjust: still Pattern-C intent-emitting (no port call)
//
// No DB, no ADK runner, no real prisma.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock VentasBackend factory ────────────────────────────────────────────────
// We mock the factory so both tools get our mockVentasBackend.

const mockVentasBackend = {
  queryCatalog: vi.fn(),
  getLowStockProducts: vi.fn(),
  getProductStock: vi.fn(),
};

vi.mock("@/lib/mcp/_lib/ventas-backend.factory", () => ({
  createVentasBackend: () => mockVentasBackend,
}));

// ── Mock prisma — must NOT be called by tool bodies after the port migration ──
const prismaMock = {
  product: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// ── Shared backend context ────────────────────────────────────────────────────

const BASE_STOCK_BACKEND = {
  businessId: "biz-inv-test-001",
  actorUserId: "supervisor-a2a",
  actorEmployeeId: null,
  // productDirectory is used by filter=all and filter=single paths (not under test here)
  productDirectory: [
    {
      id: "prod-abc",
      name: "Yerba Mate 1kg",
      price: 1500,
      stock: 42,
      sku: "YERBA-01",
      costPrice: 1000,
      weightGrams: 1000,
      reorderThreshold: 5,
    },
  ],
  business: { name: "Test Business", currency: "ARS" },
  inventorySummary: { productLines: 1, totalUnits: 42, totalValue: 42000 },
  locale: "es-AR",
  currency: "ARS",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("inventario read tools — port delegation (no direct Prisma)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── (b1) consultar_stock filter=low_stock ──────────────────────────────────

  it("(b1) consultar_stock low_stock: calls getLowStockProducts via port, NOT prisma.product.findMany", async () => {
    mockVentasBackend.getLowStockProducts.mockResolvedValue([
      { id: "prod-abc", name: "Yerba Mate 1kg", stock: 3, reorderThreshold: 5 },
    ]);

    const { createConsultarStockTool } = await import("@/lib/adk/tools/stock-consultar-tool");
    const tool = createConsultarStockTool(BASE_STOCK_BACKEND);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({ filter: "low_stock" });

    // Port called with correct tenantId
    expect(mockVentasBackend.getLowStockProducts).toHaveBeenCalledTimes(1);
    expect(mockVentasBackend.getLowStockProducts).toHaveBeenCalledWith({ tenantId: "biz-inv-test-001" });

    // Prisma NOT called directly
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();

    // Correct response shape
    expect(result).toMatchObject({
      low_stock_count: 1,
      items: [
        expect.objectContaining({
          id: "prod-abc",
          name: "Yerba Mate 1kg",
          stock: 3,
          reorder_threshold: 5,
        }),
      ],
    });
    expect(result.answer).toContain("1 productos con stock bajo");
  });

  // ── (b2) gestionar_stock action=stocktake ──────────────────────────────────

  it("(b2) gestionar_stock stocktake: calls getProductStock via port, NOT prisma.product.findFirst", async () => {
    // System quantity = 50; counted = 45 → variance = -5 (faltante)
    mockVentasBackend.getProductStock.mockResolvedValue({ quantity: 50 });

    const { createGestionarStockTool } = await import("@/lib/adk/tools/stock-gestionar-tool");
    const tool = createGestionarStockTool(BASE_STOCK_BACKEND);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      action: "stocktake",
      product_name: "Yerba Mate 1kg",
      quantity: 45,
      idempotency_key: "stocktake-yerba-001",
    });

    // Port called with correct tenantId + productId from the in-memory match
    expect(mockVentasBackend.getProductStock).toHaveBeenCalledTimes(1);
    expect(mockVentasBackend.getProductStock).toHaveBeenCalledWith({
      tenantId: "biz-inv-test-001",
      productId: "prod-abc",
    });

    // Prisma NOT called directly
    expect(prismaMock.product.findFirst).not.toHaveBeenCalled();

    // Emits adjust_stock intent with mode=set (Pattern-C — no DB write here)
    expect(result).toMatchObject({
      intent: "adjust_stock",
      data: { productName: "Yerba Mate 1kg", mode: "set", quantity: 45 },
    });
    expect(result.summary).toContain("faltante");
  });

  // ── (b3) getLowStockProducts empty → "sin stock bajo" response ───────────

  it("(b3) consultar_stock low_stock returns correct message when no low-stock products", async () => {
    mockVentasBackend.getLowStockProducts.mockResolvedValue([]);

    const { createConsultarStockTool } = await import("@/lib/adk/tools/stock-consultar-tool");
    const tool = createConsultarStockTool(BASE_STOCK_BACKEND);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({ filter: "low_stock" });

    expect(result).toMatchObject({
      low_stock_count: 0,
      items: [],
    });
    expect(result.answer).toContain("encima del punto de reorden");
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
  });

  // ── (b4) getProductStock returns null → PRODUCT_NOT_FOUND error ───────────

  it("(b4) gestionar_stock stocktake returns PRODUCT_NOT_FOUND when port returns null", async () => {
    mockVentasBackend.getProductStock.mockResolvedValue(null);

    const { createGestionarStockTool } = await import("@/lib/adk/tools/stock-gestionar-tool");
    const tool = createGestionarStockTool(BASE_STOCK_BACKEND);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      action: "stocktake",
      product_name: "Yerba Mate 1kg",
      quantity: 45,
      idempotency_key: "stocktake-yerba-002",
    });

    expect(result).toMatchObject({
      error: { code: "PRODUCT_NOT_FOUND" },
    });
    expect(prismaMock.product.findFirst).not.toHaveBeenCalled();
  });

  // ── (b5) stocktake zero variance → no-op message, no intent ──────────────

  it("(b5) gestionar_stock stocktake with zero variance: no intent emitted, no-op message", async () => {
    // System = counted = 42 → variance = 0
    mockVentasBackend.getProductStock.mockResolvedValue({ quantity: 42 });

    const { createGestionarStockTool } = await import("@/lib/adk/tools/stock-gestionar-tool");
    const tool = createGestionarStockTool(BASE_STOCK_BACKEND);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      action: "stocktake",
      product_name: "Yerba Mate 1kg",
      quantity: 42,
      idempotency_key: "stocktake-yerba-003",
    });

    // No intent — zero variance, nothing to adjust
    expect(result.intent).toBeUndefined();
    expect(result.variance).toBe(0);
    expect(result.message).toContain("Sin diferencia");
    expect(prismaMock.product.findFirst).not.toHaveBeenCalled();
  });

  // ── (b6) load/adjust actions still Pattern-C — port NOT called ────────────

  it("(b6) gestionar_stock load: Pattern-C intent, getLowStockProducts NOT called", async () => {
    const { createGestionarStockTool } = await import("@/lib/adk/tools/stock-gestionar-tool");
    const tool = createGestionarStockTool(BASE_STOCK_BACKEND);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      action: "load",
      product_name: "Yerba Mate 1kg",
      quantity: 10,
      idempotency_key: "load-yerba-001",
    });

    // Pattern-C: returns intent, no port or prisma calls
    expect(result).toMatchObject({ intent: "stock_load" });
    expect(mockVentasBackend.getProductStock).not.toHaveBeenCalled();
    expect(mockVentasBackend.getLowStockProducts).not.toHaveBeenCalled();
    expect(prismaMock.product.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
  });

  it("(b6b) gestionar_stock adjust: Pattern-C intent, port NOT called", async () => {
    const { createGestionarStockTool } = await import("@/lib/adk/tools/stock-gestionar-tool");
    const tool = createGestionarStockTool(BASE_STOCK_BACKEND);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      action: "adjust",
      product_name: "Yerba Mate 1kg",
      quantity: 5,
      mode: "increase",
      idempotency_key: "adjust-yerba-001",
    });

    expect(result).toMatchObject({ intent: "adjust_stock" });
    expect(mockVentasBackend.getProductStock).not.toHaveBeenCalled();
    expect(prismaMock.product.findFirst).not.toHaveBeenCalled();
  });
});
