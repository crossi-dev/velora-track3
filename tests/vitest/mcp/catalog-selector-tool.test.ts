// tests/vitest/mcp/catalog-selector-tool.test.ts
//
// Unit tests for the open_catalog_selector render tool registered in ventas-tools.ts.
// Uses InMemoryTransport.createLinkedPair() — mirrors the ventas-tools.test.ts style.
//
// Mocked dependency:
//   - @/lib/prisma — product.findMany (via ventas-queries.ts)
//
// Tests cover:
//   1. open_catalog_selector appears in tools/list when businessId is present
//   2. open_catalog_selector NOT registered when no businessId
//   3. UCP mapping: title from name, price_range.min.amount = pesos × 100, currency "ARS"
//   4. Single flat variant per product (Velora products are flat)
//   5. variant.availability.in_stock = stock > 0; variant.availability.quantity = stock
//   6. Tenant scoping: businessId from closure, NOT from tool input
//   7. structuredContent.prefill.products contains UCP-shaped products
//   8. search filter is forwarded to the backend query
//
// UCP Catalog spec source: https://ucp.dev/latest/specification/catalog/

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { productFindManyMock } = vi.hoisted(() => ({
  productFindManyMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findMany: productFindManyMock },
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// ── Types ─────────────────────────────────────────────────────────────────────

interface UCPAmount {
  amount: number;
  currency: string;
}

interface UCPVariant {
  id: string;
  sku?: string;
  availability: { in_stock: boolean; quantity?: number };
  price: UCPAmount;
}

interface UCPProduct {
  id: string;
  title: string;
  description: string;
  price_range: { min: UCPAmount; max: UCPAmount };
  variants: UCPVariant[];
}

interface TextContent { type: "text"; text: string }
interface CallToolResult { isError?: boolean; content: TextContent[]; structuredContent?: unknown }

function asToolResult(raw: unknown): CallToolResult {
  return raw as CallToolResult;
}

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
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

function makeProductRow(overrides: Partial<{
  id: string; name: string; price: number; costPrice: number | null;
  sku: string | null; quantity: number; weightGrams: number | null;
}> = {}) {
  return {
    id: "prod-001",
    name: "Alfajor triple",
    price: 3500,
    costPrice: 2000,
    sku: "ALF-TRIP-01",
    quantity: 48,
    weightGrams: 80,
    ...overrides,
  };
}

const BUSINESS_ID = "biz-catalog-001";

// ── Registration ──────────────────────────────────────────────────────────────

describe("catalog selector tool — registration", () => {
  it("includes open_catalog_selector when businessId is provided", async () => {
    productFindManyMock.mockResolvedValue([]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("open_catalog_selector");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include open_catalog_selector when no businessId", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("open_catalog_selector");
    } finally {
      await cleanup();
    }
  });
});

// ── UCP Catalog mapping ───────────────────────────────────────────────────────

describe("open_catalog_selector — UCP mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps title from product name", async () => {
    productFindManyMock.mockResolvedValue([
      makeProductRow({ name: "Yerba Mate 1kg", price: 1500 }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      expect(sc.prefill.products[0].title).toBe("Yerba Mate 1kg");
    } finally {
      await cleanup();
    }
  });

  it("maps price_range.min.amount = pesos × 100 (centavos) with currency ARS", async () => {
    productFindManyMock.mockResolvedValue([
      makeProductRow({ price: 1500 }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      const p = sc.prefill.products[0];
      expect(p.price_range.min.amount).toBe(150000);  // 1500 × 100
      expect(p.price_range.min.currency).toBe("ARS");
      expect(p.price_range.max.amount).toBe(150000);  // flat product: min === max
      expect(p.price_range.max.currency).toBe("ARS");
    } finally {
      await cleanup();
    }
  });

  it("maps fractional pesos correctly (round to centavos)", async () => {
    productFindManyMock.mockResolvedValue([
      makeProductRow({ price: 1499.99 }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      const p = sc.prefill.products[0];
      expect(p.price_range.min.amount).toBe(149999);  // Math.round(1499.99 × 100)
    } finally {
      await cleanup();
    }
  });

  it("maps a single flat variant per product (Velora products are flat)", async () => {
    productFindManyMock.mockResolvedValue([makeProductRow()]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      const variants = sc.prefill.products[0].variants;
      expect(variants).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("variant.id = '{productId}:default'", async () => {
    productFindManyMock.mockResolvedValue([makeProductRow({ id: "prod-xyz" })]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      expect(sc.prefill.products[0].variants[0].id).toBe("prod-xyz:default");
    } finally {
      await cleanup();
    }
  });

  it("variant.availability.in_stock = true when stock > 0", async () => {
    productFindManyMock.mockResolvedValue([makeProductRow({ quantity: 5 })]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      expect(sc.prefill.products[0].variants[0].availability.in_stock).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("variant.availability.in_stock = false when stock === 0", async () => {
    productFindManyMock.mockResolvedValue([makeProductRow({ quantity: 0 })]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      expect(sc.prefill.products[0].variants[0].availability.in_stock).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("variant.availability.quantity = stock value from Velora", async () => {
    productFindManyMock.mockResolvedValue([makeProductRow({ quantity: 42 })]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      expect(sc.prefill.products[0].variants[0].availability.quantity).toBe(42);
    } finally {
      await cleanup();
    }
  });

  it("includes sku in variant when product has a sku", async () => {
    productFindManyMock.mockResolvedValue([makeProductRow({ sku: "ALF-001" })]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      expect(sc.prefill.products[0].variants[0].sku).toBe("ALF-001");
    } finally {
      await cleanup();
    }
  });

  it("omits sku from variant when product has no sku (null)", async () => {
    productFindManyMock.mockResolvedValue([makeProductRow({ sku: null })]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      expect(sc.prefill.products[0].variants[0].sku).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("structuredContent.prefill.products contains the full mapped UCP list", async () => {
    productFindManyMock.mockResolvedValue([
      makeProductRow({ id: "p1", name: "Producto A", price: 1000 }),
      makeProductRow({ id: "p2", name: "Producto B", price: 2000 }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { products: UCPProduct[] } };
      expect(sc.prefill.products).toHaveLength(2);
      expect(sc.prefill.products[0].id).toBe("p1");
      expect(sc.prefill.products[1].id).toBe("p2");
    } finally {
      await cleanup();
    }
  });
});

// ── Tenant scoping ────────────────────────────────────────────────────────────

describe("open_catalog_selector — tenant scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses businessId from closure — findMany is called with the correct businessId", async () => {
    productFindManyMock.mockResolvedValue([]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({ name: "open_catalog_selector", arguments: {} });
      expect(productFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({ businessId: BUSINESS_ID }),
            ]),
          }),
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("does NOT use businessId from tool arguments", async () => {
    productFindManyMock.mockResolvedValue([]);
    const OTHER_BIZ = "biz-other-999";
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      // Even if a rogue client passes businessId in the arguments, the tool ignores it
      await client.callTool({
        name: "open_catalog_selector",
        arguments: { businessId: OTHER_BIZ },
      });
      // DB must have been called with BUSINESS_ID (from closure), not OTHER_BIZ
      expect(productFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({ businessId: BUSINESS_ID }),
            ]),
          }),
        }),
      );
      expect(productFindManyMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({ businessId: OTHER_BIZ }),
            ]),
          }),
        }),
      );
    } finally {
      await cleanup();
    }
  });
});

// ── Search filter ─────────────────────────────────────────────────────────────

describe("open_catalog_selector — search filter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards the search param to the backend query", async () => {
    productFindManyMock.mockResolvedValue([makeProductRow({ name: "Alfajor triple" })]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({ name: "open_catalog_selector", arguments: { search: "alfajor" } });
      expect(productFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                name: expect.objectContaining({ contains: "alfajor" }),
              }),
            ]),
          }),
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true when backend throws", async () => {
    productFindManyMock.mockRejectedValue(new Error("DB timeout"));
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_catalog_selector", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe("CATALOG_QUERY_ERROR");
    } finally {
      await cleanup();
    }
  });
});
