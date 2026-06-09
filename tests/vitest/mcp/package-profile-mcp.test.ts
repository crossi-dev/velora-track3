// tests/vitest/mcp/package-profile-mcp.test.ts
//
// Unit tests for the get_package_profile MCP tool (added in Batch 2).
// Uses InMemoryTransport.createLinkedPair() — mirrors logistica-tools.test.ts style.
//
// Mocked dependencies:
//   - prisma.saleItem.findMany  — controls SaleItem → Product weight lookup
//   - prisma.product.findMany   — controls productIds weight lookup
//
// No real DB, no real courier calls.
//
// Tests cover:
//   - get_package_profile is registered when businessId present
//   - happy path via saleId → returns correct total weight + breakdown
//   - happy path via productIds → correct weight per item
//   - weightGramsOverride wins over saleId (highest priority)
//   - products with null weightGrams fall back to 500 g/item (hasRealWeightData: false)
//   - no inputs → returns single-item 500 g default (not isError)
//   - DB failure on saleId → degrades gracefully to single-item 500 g (not isError)
//   - TENANT ISOLATION: saleId from another business returns empty/zero profile
//   - TENANT ISOLATION: productIds from another business return no weights

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { saleItemFindManyMock, productFindManyMock, getMpTokenForBusinessMock } = vi.hoisted(() => ({
  saleItemFindManyMock: vi.fn(),
  productFindManyMock: vi.fn(),
  getMpTokenForBusinessMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    saleItem: { findMany: saleItemFindManyMock },
    product: { findMany: productFindManyMock },
    // Stubs for other packs
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista", courierPreference: null }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    courierCredential: { findMany: vi.fn().mockResolvedValue([]) },
    customer: { findMany: vi.fn().mockResolvedValue([]) },
    paymentIntent: { findFirst: vi.fn().mockResolvedValue(null) },
    mpConnection: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
    // Stub for resolveTenantBackendMap — null = all env / "velora" defaults
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers",
  async (importOriginal) => {
    const original = await importOriginal<
      typeof import("@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers")
    >();
    return { ...original, getMpTokenForBusiness: getMpTokenForBusinessMock };
  },
);

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/mp-status-helpers",
  () => ({ getMpPaymentStatusByPreference: vi.fn() }),
);

vi.mock(
  "@/app/api/agents/logistica/jsonrpc/_lib/courier-registry",
  () => ({
    COURIER_REGISTRY: [],
    getCourierEntry: vi.fn().mockReturnValue(null),
    getActiveCourierNames: () => [],
  }),
);

vi.mock("@/infrastructure/shared/customer-mutations", () => ({
  createCustomerInTransaction: vi.fn(),
  updateCustomerInTransaction: vi.fn(),
}));

// ── Types ─────────────────────────────────────────────────────────────────────

interface TextContent { type: "text"; text: string; }
interface CallToolResult { isError?: boolean; content: TextContent[]; }
function asToolResult(raw: unknown): CallToolResult { return raw as CallToolResult; }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildConnectedClient(businessId?: string): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
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

describe("get_package_profile — registration", () => {
  it("is included when businessId is present", async () => {
    productFindManyMock.mockResolvedValue([]);
    const { client, cleanup } = await buildConnectedClient("biz-pkg-001");
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("get_package_profile");
    } finally {
      await cleanup();
    }
  });

  it("is NOT registered when no businessId", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("get_package_profile");
    } finally {
      await cleanup();
    }
  });
});

// ── get_package_profile ───────────────────────────────────────────────────────

describe("get_package_profile tool", () => {
  const BUSINESS_ID = "biz-pkg-tests-001";

  beforeEach(() => {
    vi.clearAllMocks();
    productFindManyMock.mockResolvedValue([]);
  });

  it("computes weight from saleId (happy path with real weights)", async () => {
    saleItemFindManyMock.mockResolvedValue([
      { quantity: 2, productId: "prod-a", product: { weightGrams: 1000 } },
      { quantity: 1, productId: "prod-b", product: { weightGrams: 500 } },
    ]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_package_profile",
        arguments: { saleId: "sale-001" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        weightGrams: number;
        hasRealWeightData: boolean;
        itemCount: number;
        breakdown: Array<{ productId: string; quantity: number; weightGrams: number }>;
      };
      // 2 × 1000 + 1 × 500 = 2500 g
      expect(parsed.weightGrams).toBe(2500);
      expect(parsed.hasRealWeightData).toBe(true);
      expect(parsed.itemCount).toBe(3);
      expect(parsed.breakdown).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("falls back to 500 g/item when product has no weightGrams (hasRealWeightData: false)", async () => {
    saleItemFindManyMock.mockResolvedValue([
      { quantity: 3, productId: "prod-noweight", product: { weightGrams: null } },
    ]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_package_profile",
        arguments: { saleId: "sale-002" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        weightGrams: number;
        hasRealWeightData: boolean;
      };
      // 3 × 500 = 1500 g fallback
      expect(parsed.weightGrams).toBe(1500);
      expect(parsed.hasRealWeightData).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("computes weight from productIds (one each)", async () => {
    productFindManyMock.mockResolvedValue([
      { id: "prod-x", weightGrams: 750 },
      { id: "prod-y", weightGrams: 250 },
    ]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_package_profile",
        arguments: { productIds: ["prod-x", "prod-y"] },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        weightGrams: number;
        hasRealWeightData: boolean;
        itemCount: number;
      };
      expect(parsed.weightGrams).toBe(1000);
      expect(parsed.hasRealWeightData).toBe(true);
      expect(parsed.itemCount).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("weightGramsOverride wins over saleId", async () => {
    // saleItem mock should NOT be called when override is present
    saleItemFindManyMock.mockResolvedValue([
      { quantity: 10, productId: "prod-heavy", product: { weightGrams: 5000 } },
    ]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_package_profile",
        arguments: { saleId: "sale-003", weightGramsOverride: 300 },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        weightGrams: number;
        hasRealWeightData: boolean;
        itemCount: number;
      };
      // Override wins — returns exactly 300 g, not the saleItem weight
      expect(parsed.weightGrams).toBe(300);
      expect(parsed.hasRealWeightData).toBe(true);
      expect(parsed.itemCount).toBe(1);
      expect(saleItemFindManyMock).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("returns single-item 500 g default when no inputs provided (not isError)", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_package_profile",
        arguments: {},
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        weightGrams: number;
        hasRealWeightData: boolean;
        itemCount: number;
      };
      expect(parsed.weightGrams).toBe(500);
      expect(parsed.hasRealWeightData).toBe(false);
      expect(parsed.itemCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("degrades gracefully to 500 g default when saleItem DB query fails (not isError)", async () => {
    saleItemFindManyMock.mockRejectedValue(new Error("DB timeout"));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_package_profile",
        arguments: { saleId: "sale-fail" },
      });
      const result = asToolResult(raw);

      // Graceful degradation — not an error, returns default estimate
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        weightGrams: number;
        hasRealWeightData: boolean;
      };
      expect(parsed.weightGrams).toBe(500);
      expect(parsed.hasRealWeightData).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  it("TENANT ISOLATION: saleId from another business returns empty/zero profile (not their data)", async () => {
    // The businessId-scoped where clause returns zero rows because the sale belongs
    // to a different tenant. The old code had no businessId filter — this test would
    // FAIL on the old code (it returned items and a non-zero weight).
    saleItemFindManyMock.mockResolvedValue([]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_package_profile",
        arguments: { saleId: "sale-foreign-tenant-999" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        weightGrams: number;
        hasRealWeightData: boolean;
        itemCount: number;
        breakdown: unknown[];
      };
      // Zero items found → falls through to single-item 500 g default
      expect(parsed.itemCount).toBe(0);
      expect(parsed.weightGrams).toBe(0);
      expect(parsed.breakdown).toHaveLength(0);
      // Verify the where clause included the businessId filter
      expect(saleItemFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sale: { is: { businessId: BUSINESS_ID } } }),
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("TENANT ISOLATION: productIds from another business return no weights (scoped by businessId)", async () => {
    // businessId-scoped where returns empty → productIds map to unknown → fallback weight used
    // The old code had no businessId filter — foreign products would return real weights.
    productFindManyMock.mockResolvedValue([]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_package_profile",
        arguments: { productIds: ["foreign-prod-aaa", "foreign-prod-bbb"] },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        weightGrams: number;
        hasRealWeightData: boolean;
        itemCount: number;
      };
      // No products found for this tenant → all items fall back to 500 g/item
      expect(parsed.hasRealWeightData).toBe(false);
      expect(parsed.itemCount).toBe(2);
      expect(parsed.weightGrams).toBe(1000); // 2 × 500 g fallback
      // Verify the where clause included the businessId filter
      expect(productFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ businessId: BUSINESS_ID }),
        }),
      );
    } finally {
      await cleanup();
    }
  });
});
