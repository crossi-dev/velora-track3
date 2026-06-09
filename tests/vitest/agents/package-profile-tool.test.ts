// tests/vitest/agents/package-profile-tool.test.ts
//
// Unit tests for the ADK get_package_profile FunctionTool (logistica agent).
// Exercises createGetPackageProfileTool(businessId) directly — no ADK runner,
// no MCP transport.
//
// Mocked:
//   prisma.saleItem.findMany  — SaleItem → Product weight lookup
//   prisma.product.findMany   — productIds weight lookup
//
// Tests cover:
//   - happy path via saleId → correct total weight + itemCount
//   - happy path via productIds → correct weight per product
//   - weightGramsOverride bypasses DB entirely
//   - fallback to 500 g/item when weightGrams is null (hasRealWeightData: false)
//   - no inputs → single-item 500 g default
//   - DB failure on saleId → graceful degradation
//   - TENANT ISOLATION: foreign saleId returns nothing (saleItem where includes businessId)
//   - TENANT ISOLATION: foreign productIds return no weights (product where includes businessId)
//   - SEAM: backendOverride routes through backend when provided (flag-ON equivalent)
//   - SEAM: legacy path used when no backendOverride and AGENT_LOGISTICA_BACKEND unset (flag-OFF)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createGetPackageProfileTool } from "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/package-profile-tool";
import type { PackageProfile } from "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/package-profile-tool";
import type { LogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.port";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { saleItemFindManyMock, productFindManyMock } = vi.hoisted(() => ({
  saleItemFindManyMock: vi.fn(),
  productFindManyMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    saleItem: { findMany: saleItemFindManyMock },
    product: { findMany: productFindManyMock },
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const BUSINESS_ID = "biz-adk-pkg-test-001";
const FOREIGN_BUSINESS_ID = "biz-foreign-999";

/** Calls the tool's execute function directly (bypasses ADK runner). */
async function callTool(
  businessId: string,
  args: { saleId?: string; productIds?: string[]; weightGramsOverride?: number },
  backendOverride?: LogisticaBackend | null,
): Promise<PackageProfile> {
  const tool = createGetPackageProfileTool(
    businessId,
    backendOverride !== undefined ? { backendOverride } : {},
  );
  // FunctionTool.execute is the handler registered at construction time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal for unit test
  return (tool as any).execute(args) as Promise<PackageProfile>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createGetPackageProfileTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes weight from saleId (happy path with real weights)", async () => {
    saleItemFindManyMock.mockResolvedValue([
      { quantity: 2, product: { weightGrams: 1000 } },
      { quantity: 1, product: { weightGrams: 500 } },
    ]);

    const result = await callTool(BUSINESS_ID, { saleId: "sale-001" });

    // 2 × 1000 + 1 × 500 = 2500
    expect(result.weightGrams).toBe(2500);
    expect(result.hasRealWeightData).toBe(true);
    expect(result.itemCount).toBe(3);
  });

  it("scopes saleItem query through Sale relation (tenant isolation)", async () => {
    saleItemFindManyMock.mockResolvedValue([]);

    await callTool(BUSINESS_ID, { saleId: "sale-foreign" });

    expect(saleItemFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          saleId: "sale-foreign",
          sale: { is: { businessId: BUSINESS_ID } },
        }),
      }),
    );
  });

  it("TENANT ISOLATION: foreign saleId returns zero-item profile (not cross-tenant data)", async () => {
    // Simulates the DB returning 0 rows because the sale belongs to a different tenant.
    saleItemFindManyMock.mockResolvedValue([]);

    const result = await callTool(BUSINESS_ID, { saleId: "sale-foreign-tenant" });

    // Zero items — falls through sumWeight to totalGrams=0, itemCount=0
    expect(result.itemCount).toBe(0);
    expect(result.weightGrams).toBe(0);
    // allHaveRealWeight stays true on empty — no fallback items added
    expect(result.hasRealWeightData).toBe(true);
  });

  it("computes weight from productIds (one each)", async () => {
    productFindManyMock.mockResolvedValue([
      { id: "prod-a", weightGrams: 750 },
      { id: "prod-b", weightGrams: 250 },
    ]);

    const result = await callTool(BUSINESS_ID, { productIds: ["prod-a", "prod-b"] });

    expect(result.weightGrams).toBe(1000);
    expect(result.hasRealWeightData).toBe(true);
    expect(result.itemCount).toBe(2);
  });

  it("scopes product query by businessId (tenant isolation)", async () => {
    productFindManyMock.mockResolvedValue([]);

    await callTool(BUSINESS_ID, { productIds: ["prod-x"] });

    expect(productFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["prod-x"] },
          businessId: BUSINESS_ID,
        }),
      }),
    );
  });

  it("TENANT ISOLATION: foreign productIds return fallback weights only (not cross-tenant data)", async () => {
    // Simulates the DB returning 0 rows because the products belong to a different tenant.
    productFindManyMock.mockResolvedValue([]);

    const result = await callTool(BUSINESS_ID, { productIds: ["foreign-prod-aaa", "foreign-prod-bbb"] });

    // No real weight data found → falls back to 500 g/item each
    expect(result.hasRealWeightData).toBe(false);
    expect(result.itemCount).toBe(2);
    expect(result.weightGrams).toBe(1000); // 2 × 500 g fallback
  });

  it("businessId in closure is used — not overrideable by a different call", async () => {
    productFindManyMock.mockResolvedValue([]);
    saleItemFindManyMock.mockResolvedValue([]);

    // Two tools with different businessIds — each should use its own
    await callTool(BUSINESS_ID, { productIds: ["p1"] });
    expect(productFindManyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ businessId: BUSINESS_ID }) }),
    );

    await callTool(FOREIGN_BUSINESS_ID, { productIds: ["p2"] });
    expect(productFindManyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ businessId: FOREIGN_BUSINESS_ID }) }),
    );
  });

  it("weightGramsOverride bypasses DB entirely", async () => {
    const result = await callTool(BUSINESS_ID, {
      saleId: "sale-ignored",
      weightGramsOverride: 300,
    });

    expect(result.weightGrams).toBe(300);
    expect(result.hasRealWeightData).toBe(true);
    expect(result.itemCount).toBe(1);
    expect(saleItemFindManyMock).not.toHaveBeenCalled();
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("falls back to 500 g/item when product has no weightGrams (hasRealWeightData: false)", async () => {
    saleItemFindManyMock.mockResolvedValue([
      { quantity: 3, product: { weightGrams: null } },
    ]);

    const result = await callTool(BUSINESS_ID, { saleId: "sale-no-weight" });

    expect(result.weightGrams).toBe(1500); // 3 × 500
    expect(result.hasRealWeightData).toBe(false);
    expect(result.itemCount).toBe(3);
  });

  it("returns single-item 500 g default when no inputs provided", async () => {
    const result = await callTool(BUSINESS_ID, {});

    expect(result.weightGrams).toBe(500);
    expect(result.hasRealWeightData).toBe(false);
    expect(result.itemCount).toBe(1);
    expect(saleItemFindManyMock).not.toHaveBeenCalled();
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("degrades gracefully to 500 g default when DB query fails", async () => {
    saleItemFindManyMock.mockRejectedValue(new Error("DB timeout"));

    const result = await callTool(BUSINESS_ID, { saleId: "sale-fail" });

    expect(result.weightGrams).toBe(500);
    expect(result.hasRealWeightData).toBe(false);
    expect(result.itemCount).toBe(1);
  });

  // ── SEAM tests (AGENT_LOGISTICA_BACKEND routing) ───────────────────────────

  it("SEAM ON: backendOverride routes getPackageProfile through the backend stub", async () => {
    const stubResult = { weightGrams: 9999, hasRealWeightData: true, itemCount: 7, breakdown: [] };
    const backendStub: LogisticaBackend = {
      getPackageProfile: vi.fn().mockResolvedValue(stubResult),
      resolveActiveCouriers: vi.fn(),
      getCourierEntryForCreate: vi.fn(),
      getCourierEntryForTrack: vi.fn(),
    };

    const result = await callTool(BUSINESS_ID, { saleId: "sale-seam" }, backendStub);

    expect(backendStub.getPackageProfile).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: BUSINESS_ID, saleId: "sale-seam" }),
    );
    expect(result.weightGrams).toBe(9999);
    expect(result.itemCount).toBe(7);
    // Legacy prisma mocks NOT called — backend handled it.
    expect(saleItemFindManyMock).not.toHaveBeenCalled();
  });

  it("SEAM OFF: when no backendOverride and AGENT_LOGISTICA_BACKEND unset, uses legacy prisma path", async () => {
    const savedEnv = process.env.AGENT_LOGISTICA_BACKEND;
    delete process.env.AGENT_LOGISTICA_BACKEND;

    saleItemFindManyMock.mockResolvedValue([
      { quantity: 1, product: { weightGrams: 1200 } },
    ]);

    // null backendOverride → explicit legacy (flag OFF).
    const result = await callTool(BUSINESS_ID, { saleId: "sale-legacy" }, null);

    expect(saleItemFindManyMock).toHaveBeenCalled();
    expect(result.weightGrams).toBe(1200);

    if (savedEnv !== undefined) process.env.AGENT_LOGISTICA_BACKEND = savedEnv;
  });
});
