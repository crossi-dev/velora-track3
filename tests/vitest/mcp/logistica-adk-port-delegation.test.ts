// tests/vitest/mcp/logistica-adk-port-delegation.test.ts
//
// Verifies that the logistica ADK read tools (logistica.cotizar_envio and
// logistica.seleccionar_courier) delegate to the LogisticaBackend port instead
// of calling prisma directly.
//
// Mirrors inventario-port-delegation.test.ts style:
//   (c1) cotizar_envio: calls backend.resolveActiveCouriers via port, NOT prisma
//   (c2) seleccionar_courier via saleId: calls backend.getPackageProfile, NOT prisma
//   (c3) seleccionar_courier via productIds: calls backend.getPackageProfile, NOT prisma
//   (c4) seleccionar_courier with weightGramsOverride: calls backend, NOT prisma
//   (c5) cotizar_envio with backendOverride (test injection) uses injected backend
//   (c6) seleccionar_courier with backendOverride uses injected backend
//
// No DB, no ADK runner, no real carrier API calls.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock LogisticaBackend factory ─────────────────────────────────────────────
// We mock the factory so both tools get our mockLogisticaBackend.

const mockLogisticaBackend = {
  resolveActiveCouriers: vi.fn(),
  getCourierEntryForCreate: vi.fn(),
  getCourierEntryForTrack: vi.fn(),
  getPackageProfile: vi.fn(),
};

vi.mock("@/lib/mcp/_lib/logistica-backend.factory", () => ({
  createLogisticaBackend: () => mockLogisticaBackend,
}));

// ── Mock prisma — must NOT be called by tool bodies after the port migration ──
const prismaMock = {
  courierCredential: { findMany: vi.fn() },
  business: { findUnique: vi.fn() },
  saleItem: { findMany: vi.fn() },
  product: { findMany: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// ── Mock courier-registry — needed by rate-comparison-tool imports ─────────────
const mockAdapter = {
  quote: vi.fn(),
  create: vi.fn(),
  track: vi.fn(),
};

vi.mock(
  "@/app/api/agents/logistica/jsonrpc/_lib/courier-registry",
  () => ({
    COURIER_REGISTRY: [],
    getCourierEntry: vi.fn().mockReturnValue(undefined),
    getActiveCourierNames: () => [],
  }),
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("logistica ADK read tools — port delegation (no direct Prisma)", () => {
  const TRUSTED_BIZ_ID = "biz-log-port-001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── (c1) cotizar_envio: resolveActiveCouriers via port ────────────────────

  it("(c1) cotizar_envio: calls backend.resolveActiveCouriers via port, NOT prisma", async () => {
    // Backend returns empty couriers → no fan-out, empty options
    mockLogisticaBackend.resolveActiveCouriers.mockResolvedValue({ activeCouriers: [] });

    const { createCompareRatesTool } = await import(
      "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/rate-comparison-tool"
    );
    const tool = createCompareRatesTool(TRUSTED_BIZ_ID);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      originPostalCode: "5500",
      destinationPostalCode: "1001",
      weightGrams: 1000,
      businessId: "should-be-ignored",
    });

    // Port called with correct tenantId (from closure — not LLM input)
    expect(mockLogisticaBackend.resolveActiveCouriers).toHaveBeenCalledTimes(1);
    expect(mockLogisticaBackend.resolveActiveCouriers).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TRUSTED_BIZ_ID, originPostalCode: "5500" }),
    );

    // Prisma NOT called directly
    expect(prismaMock.courierCredential.findMany).not.toHaveBeenCalled();
    expect(prismaMock.business.findUnique).not.toHaveBeenCalled();

    // Correct response shape — no couriers = empty options
    expect(result).toMatchObject({
      options: [],
      cheapestPriceARS: null,
      originPostalCode: "5500",
      destinationPostalCode: "1001",
    });
  });

  // ── (c2) seleccionar_courier via saleId ───────────────────────────────────

  it("(c2) seleccionar_courier via saleId: calls backend.getPackageProfile, NOT prisma.saleItem", async () => {
    mockLogisticaBackend.getPackageProfile.mockResolvedValue({
      weightGrams: 2500,
      hasRealWeightData: true,
      itemCount: 3,
      breakdown: [
        { productId: "prod-a", quantity: 2, weightGrams: 2000 },
        { productId: "prod-b", quantity: 1, weightGrams: 500 },
      ],
    });

    const { createGetPackageProfileTool } = await import(
      "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/package-profile-tool"
    );
    const tool = createGetPackageProfileTool(TRUSTED_BIZ_ID);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({ saleId: "sale-abc" });

    // Port called with correct tenantId + saleId
    expect(mockLogisticaBackend.getPackageProfile).toHaveBeenCalledTimes(1);
    expect(mockLogisticaBackend.getPackageProfile).toHaveBeenCalledWith({
      tenantId: TRUSTED_BIZ_ID,
      saleId: "sale-abc",
      productIds: undefined,
      weightGramsOverride: undefined,
    });

    // Prisma NOT called directly
    expect(prismaMock.saleItem.findMany).not.toHaveBeenCalled();
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();

    // Correct response shape from port
    expect(result).toMatchObject({
      weightGrams: 2500,
      hasRealWeightData: true,
      itemCount: 3,
    });
  });

  // ── (c3) seleccionar_courier via productIds ───────────────────────────────

  it("(c3) seleccionar_courier via productIds: calls backend.getPackageProfile, NOT prisma.product", async () => {
    mockLogisticaBackend.getPackageProfile.mockResolvedValue({
      weightGrams: 1000,
      hasRealWeightData: true,
      itemCount: 2,
      breakdown: [
        { productId: "prod-x", quantity: 1, weightGrams: 750 },
        { productId: "prod-y", quantity: 1, weightGrams: 250 },
      ],
    });

    const { createGetPackageProfileTool } = await import(
      "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/package-profile-tool"
    );
    const tool = createGetPackageProfileTool(TRUSTED_BIZ_ID);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({ productIds: ["prod-x", "prod-y"] });

    expect(mockLogisticaBackend.getPackageProfile).toHaveBeenCalledTimes(1);
    expect(mockLogisticaBackend.getPackageProfile).toHaveBeenCalledWith({
      tenantId: TRUSTED_BIZ_ID,
      saleId: undefined,
      productIds: ["prod-x", "prod-y"],
      weightGramsOverride: undefined,
    });

    // Prisma NOT called directly
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      weightGrams: 1000,
      hasRealWeightData: true,
      itemCount: 2,
    });
  });

  // ── (c4) seleccionar_courier with weightGramsOverride ────────────────────

  it("(c4) seleccionar_courier with weightGramsOverride: still calls port (not legacy), NOT prisma", async () => {
    mockLogisticaBackend.getPackageProfile.mockResolvedValue({
      weightGrams: 300,
      hasRealWeightData: true,
      itemCount: 1,
      breakdown: [],
    });

    const { createGetPackageProfileTool } = await import(
      "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/package-profile-tool"
    );
    const tool = createGetPackageProfileTool(TRUSTED_BIZ_ID);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      saleId: "sale-ignored",
      weightGramsOverride: 300,
    });

    // Port still called (the adapter handles weightGramsOverride short-circuit internally)
    expect(mockLogisticaBackend.getPackageProfile).toHaveBeenCalledTimes(1);
    expect(mockLogisticaBackend.getPackageProfile).toHaveBeenCalledWith({
      tenantId: TRUSTED_BIZ_ID,
      saleId: "sale-ignored",
      productIds: undefined,
      weightGramsOverride: 300,
    });

    // Prisma NOT called at any point
    expect(prismaMock.saleItem.findMany).not.toHaveBeenCalled();
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();

    expect(result).toMatchObject({ weightGrams: 300, hasRealWeightData: true });
  });

  // ── (c5) cotizar_envio with backendOverride uses injected backend ──────────

  it("(c5) cotizar_envio: backendOverride injected backend is used (factory NOT called)", async () => {
    const injectedBackend = {
      resolveActiveCouriers: vi.fn().mockResolvedValue({ activeCouriers: [] }),
      getCourierEntryForCreate: vi.fn(),
      getCourierEntryForTrack: vi.fn(),
      getPackageProfile: vi.fn(),
    };

    const { createCompareRatesTool } = await import(
      "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/rate-comparison-tool"
    );
    const tool = createCompareRatesTool(TRUSTED_BIZ_ID, { backendOverride: injectedBackend });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tool as any).execute({
      originPostalCode: "5500",
      destinationPostalCode: "1001",
      weightGrams: 500,
      businessId: "lllm-supplied-ignored",
    });

    // The injected backend was called, not the factory mock
    expect(injectedBackend.resolveActiveCouriers).toHaveBeenCalledTimes(1);
    expect(injectedBackend.resolveActiveCouriers).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TRUSTED_BIZ_ID }),
    );
    // Factory-created backend was NOT called
    expect(mockLogisticaBackend.resolveActiveCouriers).not.toHaveBeenCalled();
    expect(prismaMock.courierCredential.findMany).not.toHaveBeenCalled();
  });

  // ── (c6) seleccionar_courier with backendOverride ────────────────────────

  it("(c6) seleccionar_courier: backendOverride injected backend is used (factory NOT called)", async () => {
    const injectedBackend = {
      resolveActiveCouriers: vi.fn(),
      getCourierEntryForCreate: vi.fn(),
      getCourierEntryForTrack: vi.fn(),
      getPackageProfile: vi.fn().mockResolvedValue({
        weightGrams: 750,
        hasRealWeightData: false,
        itemCount: 1,
        breakdown: [],
      }),
    };

    const { createGetPackageProfileTool } = await import(
      "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/package-profile-tool"
    );
    const tool = createGetPackageProfileTool(TRUSTED_BIZ_ID, { backendOverride: injectedBackend });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({});

    // The injected backend was called, not the factory mock
    expect(injectedBackend.getPackageProfile).toHaveBeenCalledTimes(1);
    expect(injectedBackend.getPackageProfile).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TRUSTED_BIZ_ID }),
    );
    // Factory-created backend was NOT called
    expect(mockLogisticaBackend.getPackageProfile).not.toHaveBeenCalled();
    expect(prismaMock.saleItem.findMany).not.toHaveBeenCalled();

    expect(result).toMatchObject({ weightGrams: 750 });
  });
});
