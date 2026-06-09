// tests/vitest/mcp/ventas-tools.test.ts
//
// Unit tests for the Ventas read-only MCP tool registrations.
// Uses InMemoryTransport.createLinkedPair() from the MCP SDK — mirrors the
// fiscal-mcp-server.test.ts / payments-tools.test.ts style.
//
// Mocked dependency:
//   - @/lib/prisma  — product.findMany (via ventas-queries.ts)
//
// No real DB calls are made. Tests cover:
//   - tools/list includes query_catalog when businessId is present
//   - tools NOT registered when no businessId
//   - query_catalog happy path (mock rows → product list)
//   - query_catalog with search filter (verifies call params)
//   - businessId comes from closure — not from tool input
//
// Pre-existing vitest failures on main (sale-post-commit-chain, employee-auth-edge)
// are unrelated — verify this file's pass count independently.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────
//
// vi.hoisted() runs before module graph resolution so the mock factories can
// reference the fn before the vi.mock() call.

const { productFindManyMock } = vi.hoisted(() => ({
  productFindManyMock: vi.fn(),
}));

// Mock prisma — only the product.findMany method is used by ventas-queries.ts.
// Other models are stubbed as empty objects to avoid unrelated failures from
// fiscal-tools.ts or payments-tools.ts when they access business/arcaCredential.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findMany: productFindManyMock },
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    // Stub for resolveTenantBackendMap — null = all env / "velora" defaults
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// ── Types ─────────────────────────────────────────────────────────────────────

interface TextContent {
  type: "text";
  text: string;
}

interface CallToolResult {
  isError?: boolean;
  content: TextContent[];
}

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

// Sample DB row shape returned by prisma.product.findMany
function makeProductRow(overrides: Partial<{
  id: string;
  name: string;
  price: number;
  costPrice: number | null;
  sku: string | null;
  quantity: number;
  weightGrams: number | null;
}> = {}) {
  return {
    id: "prod-001",
    name: "Yerba Mate 1kg",
    price: 1500,
    costPrice: 1000,
    sku: "YERBA-01",
    quantity: 42,
    weightGrams: 1000,
    ...overrides,
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("ventas tools — registration", () => {
  it("includes query_catalog when businessId is provided", async () => {
    productFindManyMock.mockResolvedValue([]);
    const { client, cleanup } = await buildConnectedClient("biz-ventas-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("query_catalog");
      expect(names).not.toContain("get_stock");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include ventas tools when no businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("query_catalog");
      expect(names).not.toContain("get_stock");
    } finally {
      await cleanup();
    }
  });
});

// ── query_catalog ─────────────────────────────────────────────────────────────

describe("query_catalog tool", () => {
  const BUSINESS_ID = "biz-catalog-001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns mapped product list on happy path", async () => {
    productFindManyMock.mockResolvedValue([
      makeProductRow({ id: "prod-001", name: "Yerba Mate 1kg", price: 1500, quantity: 42 }),
      makeProductRow({ id: "prod-002", name: "Azúcar 1kg", price: 800, costPrice: null, sku: null, quantity: 15, weightGrams: null }),
    ]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "query_catalog", arguments: {} });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        products: Array<{
          id: string;
          name: string;
          price: number;
          stock: number;
          costPrice: number | null;
          sku: string | null;
          weightGrams: number | null;
        }>;
        total: number;
      };
      expect(parsed.total).toBe(2);
      expect(parsed.products).toHaveLength(2);
      expect(parsed.products[0].name).toBe("Yerba Mate 1kg");
      expect(parsed.products[0].price).toBe(1500);
      expect(parsed.products[0].stock).toBe(42);
      expect(parsed.products[1].costPrice).toBeNull();
      expect(parsed.products[1].sku).toBeNull();
      expect(parsed.products[1].weightGrams).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("passes search filter to the DB query when provided", async () => {
    productFindManyMock.mockResolvedValue([
      makeProductRow({ name: "Yerba Mate 1kg" }),
    ]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "query_catalog",
        arguments: { search: "yerba" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();

      // Verify findMany was called with a name filter containing the search term
      expect(productFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                name: expect.objectContaining({ contains: "yerba" }),
              }),
            ]),
          }),
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("returns empty product list when no products match", async () => {
    productFindManyMock.mockResolvedValue([]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "query_catalog", arguments: {} });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        products: unknown[];
        total: number;
      };
      expect(parsed.products).toHaveLength(0);
      expect(parsed.total).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true when DB throws", async () => {
    productFindManyMock.mockRejectedValue(new Error("DB connection lost"));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "query_catalog", arguments: {} });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe("CATALOG_QUERY_ERROR");
      expect(parsed.message).toContain("DB connection lost");
    } finally {
      await cleanup();
    }
  });

  it("uses businessId from closure — findMany is called with the correct businessId", async () => {
    productFindManyMock.mockResolvedValue([]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({ name: "query_catalog", arguments: {} });
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
});

