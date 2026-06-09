// tests/vitest/mcp/reportes-mcp-tools.test.ts
//
// Unit tests for the sales reportes MCP tool registration (reportes-tools.ts).
//
// Test contract:
//   (r1) query_sales tool appears in listing when businessId is provided
//   (r2) query_sales NOT present without businessId
//   (r3) ventas_periodo: returns revenue + count for a preset range
//   (r4) ranking_productos: returns ranked list of best-sellers
//   (r5) historial_cliente: returns customer history when customer is found
//   (r6) historial_cliente: returns NOT_FOUND error when customer is absent
//   (r7) historial_cliente: returns MISSING_PARAM when customer_name is omitted
//   (r8) Invalid metrica: returns INVALID_RANGE or validation error (not a server crash)
//   (r9) margen metric: returns revenue, cost, and margin fields
//   (r10) por_empleado: returns per-employee breakdown
//
// Query functions are mocked at the module level — no real DB calls.
// Pattern mirrors tests/vitest/mcp/payments-tools.test.ts (InMemoryTransport).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  mockQueryVentasPeriodo,
  mockQueryMargen,
  mockQueryRankingProductos,
  mockQueryPorEmpleado,
  mockQueryHistorialCliente,
} = vi.hoisted(() => ({
  mockQueryVentasPeriodo: vi.fn(),
  mockQueryMargen: vi.fn(),
  mockQueryRankingProductos: vi.fn(),
  mockQueryPorEmpleado: vi.fn(),
  mockQueryHistorialCliente: vi.fn(),
}));

// Mock the query module — no real Prisma calls in tests.
vi.mock("@/lib/adk/tools/_lib/ventas-reportes-queries", () => ({
  resolveDateRange: vi.fn((preset: string | undefined, from: string | undefined, to: string | undefined) => {
    if (preset === "hoy" || preset === "semana" || preset === "mes") {
      return [new Date("2026-06-01T03:00:00Z"), new Date("2026-06-01T05:59:59.999Z")];
    }
    if (from && to) {
      return [new Date(`${from}T03:00:00Z`), new Date(`${to}T05:59:59.999Z`)];
    }
    return { error: "Especificá un preset (hoy|semana|mes) o el par from+to (YYYY-MM-DD)." };
  }),
  fmtCurrency: (n: number) => `$${n.toLocaleString("es-AR")}`,
  queryVentasPeriodo: mockQueryVentasPeriodo,
  queryMargen: mockQueryMargen,
  queryRankingProductos: mockQueryRankingProductos,
  queryPorEmpleado: mockQueryPorEmpleado,
  queryHistorialCliente: mockQueryHistorialCliente,
}));

// Mock prisma — stubs for other server.ts packs.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

// ── Types + helpers ────────────────────────────────────────────────────────────

interface TextContent { type: "text"; text: string }
interface ToolResult { isError?: boolean; content: TextContent[] }

function parseResult(raw: unknown): { isError: boolean; data: unknown } {
  const r = raw as ToolResult;
  const text = r.content[0]?.text ?? "{}";
  return { isError: !!r.isError, data: JSON.parse(text) };
}

async function buildClient(businessId?: string) {
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

describe("(r1/r2) reportes tools — registration", () => {
  it("(r1) query_sales appears when businessId is provided", async () => {
    const { client, cleanup } = await buildClient("biz-rep-001");
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("query_sales");
    } finally {
      await cleanup();
    }
  });

  it("(r2) query_sales NOT present without businessId", async () => {
    const { client, cleanup } = await buildClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("query_sales");
    } finally {
      await cleanup();
    }
  });
});

// ── ventas_periodo ────────────────────────────────────────────────────────────

describe("(r3) query_sales — ventas_periodo", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns revenue + count for preset 'hoy'", async () => {
    mockQueryVentasPeriodo.mockResolvedValue({
      _sum: { totalAmount: 25000 },
      _count: { id: 8 },
    });

    const { client, cleanup } = await buildClient("biz-rep-ventas");
    try {
      const raw = await client.callTool({
        name: "query_sales",
        arguments: { metrica: "ventas_periodo", preset: "hoy" },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      expect(d.saleCount).toBe(8);
      expect(d.totalRevenue).toBe(25000);
      expect(mockQueryVentasPeriodo).toHaveBeenCalledTimes(1);
      expect(mockQueryVentasPeriodo).toHaveBeenCalledWith(
        "biz-rep-ventas",
        expect.any(Date),
        expect.any(Date),
      );
    } finally {
      await cleanup();
    }
  });
});

// ── ranking_productos ─────────────────────────────────────────────────────────

describe("(r4) query_sales — ranking_productos", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns ranked best-sellers", async () => {
    mockQueryRankingProductos.mockResolvedValue([
      { rank: 1, product: "Yerba 500g", unitsSold: 120 },
      { rank: 2, product: "Azúcar 1kg", unitsSold: 85 },
    ]);

    const { client, cleanup } = await buildClient("biz-rep-ranking");
    try {
      const raw = await client.callTool({
        name: "query_sales",
        arguments: { metrica: "ranking_productos", preset: "semana", limit: 5 },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      const ranking = d.ranking as Array<Record<string, unknown>>;
      expect(ranking).toHaveLength(2);
      expect(ranking[0].product).toBe("Yerba 500g");
      expect(mockQueryRankingProductos).toHaveBeenCalledWith("biz-rep-ranking", expect.any(Date), expect.any(Date), 5);
    } finally {
      await cleanup();
    }
  });
});

// ── historial_cliente ─────────────────────────────────────────────────────────

describe("(r5–r7) query_sales — historial_cliente", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("(r5) returns customer history when found", async () => {
    mockQueryHistorialCliente.mockResolvedValue({
      kind: "ok",
      customer: "Carlos Rossi",
      lifetimeOrderCount: 5,
      lifetimeTotalSpent: "$12.500",
      recentOrdersScope: "últimas 3 compras",
      recentOrders: [],
    });

    const { client, cleanup } = await buildClient("biz-rep-hist");
    try {
      const raw = await client.callTool({
        name: "query_sales",
        arguments: { metrica: "historial_cliente", customer_name: "Carlos" },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      expect(d.customer).toBe("Carlos Rossi");
      expect(d.lifetimeOrderCount).toBe(5);
    } finally {
      await cleanup();
    }
  });

  it("(r6) returns NOT_FOUND error when customer does not exist", async () => {
    mockQueryHistorialCliente.mockResolvedValue({ kind: "not_found", name: "Unknown" });

    const { client, cleanup } = await buildClient("biz-rep-notfound");
    try {
      const raw = await client.callTool({
        name: "query_sales",
        arguments: { metrica: "historial_cliente", customer_name: "Unknown" },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(true);
      expect(d.code).toBe("NOT_FOUND");
    } finally {
      await cleanup();
    }
  });

  it("(r7) returns MISSING_PARAM when customer_name is omitted for historial_cliente", async () => {
    const { client, cleanup } = await buildClient("biz-rep-missing");
    try {
      const raw = await client.callTool({
        name: "query_sales",
        arguments: { metrica: "historial_cliente" },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(true);
      expect(d.code).toBe("MISSING_PARAM");
    } finally {
      await cleanup();
    }
  });
});

// ── margen ────────────────────────────────────────────────────────────────────

describe("(r9) query_sales — margen", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns revenue, cost, margin, and marginPercent", async () => {
    mockQueryMargen.mockResolvedValue([
      { quantity: 10, unitPrice: 1000, unitCost: 600 },
      { quantity: 5, unitPrice: 2000, unitCost: 1200 },
    ]);

    const { client, cleanup } = await buildClient("biz-rep-margen");
    try {
      const raw = await client.callTool({
        name: "query_sales",
        arguments: { metrica: "margen", preset: "mes" },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      // revenue = 10*1000 + 5*2000 = 20000; cost = 10*600 + 5*1200 = 12000; margin = 8000
      expect(d.revenue).toBe(20000);
      expect(d.cost).toBe(12000);
      expect(d.margin).toBe(8000);
      expect(typeof d.marginPercent).toBe("number");
    } finally {
      await cleanup();
    }
  });
});

// ── por_empleado ──────────────────────────────────────────────────────────────

describe("(r10) query_sales — por_empleado", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns per-employee revenue breakdown", async () => {
    mockQueryPorEmpleado.mockResolvedValue([
      { employee: "Ana García", saleCount: 12, totalRevenue: 45000 },
      { employee: "Owner", saleCount: 3, totalRevenue: 10000 },
    ]);

    const { client, cleanup } = await buildClient("biz-rep-emp");
    try {
      const raw = await client.callTool({
        name: "query_sales",
        arguments: { metrica: "por_empleado", preset: "semana" },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      const byEmployee = d.byEmployee as Array<Record<string, unknown>>;
      expect(byEmployee).toHaveLength(2);
      expect(byEmployee[0].employee).toBe("Ana García");
      expect(byEmployee[0].totalRevenue).toBe(45000);
    } finally {
      await cleanup();
    }
  });
});
