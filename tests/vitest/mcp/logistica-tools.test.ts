// tests/vitest/mcp/logistica-tools.test.ts
//
// Unit tests for the Logística MCP tool registrations (logistica-tools.ts).
// Uses InMemoryTransport.createLinkedPair() from the MCP SDK to wire a Client
// to the McpServer without HTTP overhead — mirrors payments-tools.test.ts style.
//
// Mocked dependencies:
//   - COURIER_REGISTRY / getCourierEntry  — control which couriers are available
//   - prisma                              — controls CourierCredential + Business rows
//   - adapter.quote / create / track      — control courier API responses
//
// No real DB, no real carrier API calls.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// All mock values must be in vi.hoisted() so vi.mock factories can reference them.
const { mockAdapter, getCourierEntryMock, COURIER_REGISTRY_MOCK, prismaMock } = vi.hoisted(() => {
  const adapter = {
    quote: vi.fn(),
    create: vi.fn(),
    track: vi.fn(),
  };
  const registry = [
    { name: "andreani", active: true, getAdapter: () => adapter },
  ];
  const courierCredential = { findMany: vi.fn() };
  const business = { findUnique: vi.fn() };
  const arcaCredential = { findUnique: vi.fn().mockResolvedValue(null) };
  const product = { findMany: vi.fn().mockResolvedValue([]) };
  const tenantToolConfig = { findUnique: vi.fn().mockResolvedValue(null) };
  // PedidosYa BYOA gate (resolveActiveCouriers): default to no PedidosYa channel.
  const businessChannelCredential = { findUnique: vi.fn().mockResolvedValue(null) };
  return {
    mockAdapter: adapter,
    getCourierEntryMock: vi.fn(),
    COURIER_REGISTRY_MOCK: registry,
    prismaMock: { courierCredential, business, arcaCredential, product, tenantToolConfig, businessChannelCredential },
  };
});

vi.mock(
  "@/app/api/agents/logistica/jsonrpc/_lib/courier-registry",
  () => ({
    COURIER_REGISTRY: COURIER_REGISTRY_MOCK,
    getCourierEntry: getCourierEntryMock,
    getActiveCourierNames: () => ["andreani"],
  }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
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

/** Build a successful JsonRpcResponse wrapping any payload as adapter would return. */
function rpcOk(payload: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id: "1",
    result: {
      kind: "message",
      messageId: "msg-1",
      role: "agent",
      contextId: "1",
      skill: "test",
      parts: [{ kind: "text", text: JSON.stringify(payload) }],
    },
  };
}

/** Build a JSON-RPC error response as adapter returns on credential failure. */
function rpcErr(message: string): unknown {
  return { jsonrpc: "2.0", id: null, error: { code: -32603, message } };
}

// ── Registration tests ────────────────────────────────────────────────────────

describe("logistica tools — registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.business.findUnique.mockResolvedValue({ ivaCondition: "Monotributista", courierPreference: null });
    prismaMock.courierCredential.findMany.mockResolvedValue([]);
  });

  it("includes quote_shipping, create_shipment, and track_shipment when businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-log-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("quote_shipping");
      expect(names).toContain("create_shipment");
      expect(names).toContain("track_shipment");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include logistica tools when no businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient(); // no businessId
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("quote_shipping");
      expect(names).not.toContain("create_shipment");
      expect(names).not.toContain("track_shipment");
    } finally {
      await cleanup();
    }
  });
});

// ── quote_shipping ────────────────────────────────────────────────────────────

describe("quote_shipping tool", () => {
  const BUSINESS_ID = "biz-quote-001";

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.business.findUnique.mockResolvedValue({ ivaCondition: "Monotributista", courierPreference: null });
  });

  it("returns sorted options on happy path when credentials present", async () => {
    prismaMock.courierCredential.findMany.mockResolvedValue([{ provider: "andreani" }]);
    mockAdapter.quote.mockResolvedValue(
      rpcOk({
        options: [
          { service: "domicilio", serviceLabel: "Envío a domicilio", priceARS: 1800, estimatedDays: 3 },
          { service: "express", serviceLabel: "Express (24 hs)", priceARS: 2500, estimatedDays: 1 },
        ],
        originPostalCode: "5500",
        destinationPostalCode: "1001",
      }),
    );

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "quote_shipping",
        arguments: {
          originPostalCode: "5500",
          destinationPostalCode: "1001",
          weightGrams: 1000,
        },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        options: Array<{ provider: string; priceARS: number }>;
        cheapestPriceARS: number;
      };
      expect(parsed.options.length).toBeGreaterThan(0);
      // Sorted ascending by price.
      expect(parsed.options[0].priceARS).toBeLessThanOrEqual(parsed.options[parsed.options.length - 1].priceARS);
      expect(parsed.cheapestPriceARS).toBe(parsed.options[0].priceARS);
      expect(parsed.options[0].provider).toBe("andreani");
    } finally {
      await cleanup();
    }
  });

  it("returns empty options (not isError) when no couriers are connected and ANDREANI_CLIENT_ID absent", async () => {
    prismaMock.courierCredential.findMany.mockResolvedValue([]); // no credentials
    const savedEnv = process.env.ANDREANI_CLIENT_ID;
    delete process.env.ANDREANI_CLIENT_ID;

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "quote_shipping",
        arguments: { originPostalCode: "5500", destinationPostalCode: "1001", weightGrams: 500 },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy(); // empty is NOT an error — honest state
      const parsed = JSON.parse(result.content[0].text) as { options: unknown[]; message?: string };
      expect(parsed.options).toHaveLength(0);
      expect(parsed.message).toBeDefined();
    } finally {
      await cleanup();
      if (savedEnv !== undefined) process.env.ANDREANI_CLIENT_ID = savedEnv;
    }
  });

  it("uses Andreani global env fallback when ANDREANI_CLIENT_ID is set", async () => {
    prismaMock.courierCredential.findMany.mockResolvedValue([]); // no DB credentials
    process.env.ANDREANI_CLIENT_ID = "test-client-id";
    mockAdapter.quote.mockResolvedValue(rpcOk({ options: [] }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "quote_shipping",
        arguments: { originPostalCode: "5500", destinationPostalCode: "1001", weightGrams: 500 },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      // Adapter was called (env fallback active).
      expect(mockAdapter.quote).toHaveBeenCalled();
    } finally {
      await cleanup();
      delete process.env.ANDREANI_CLIENT_ID;
    }
  });

  it("businessId comes from closure — adapter receives the correct businessId", async () => {
    prismaMock.courierCredential.findMany.mockResolvedValue([{ provider: "andreani" }]);
    mockAdapter.quote.mockResolvedValue(rpcOk({ options: [] }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "quote_shipping",
        arguments: { originPostalCode: "5500", destinationPostalCode: "1001", weightGrams: 200 },
      });
      // The second arg to adapter.quote is always the closure businessId.
      expect(mockAdapter.quote).toHaveBeenCalledWith(
        expect.objectContaining({ originPostalCode: "5500" }),
        BUSINESS_ID,
      );
    } finally {
      await cleanup();
    }
  });
});

// ── create_shipment ───────────────────────────────────────────────────────────

describe("create_shipment tool", () => {
  const BUSINESS_ID = "biz-create-001";

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.business.findUnique.mockResolvedValue({ ivaCondition: "Monotributista", courierPreference: null });
    prismaMock.courierCredential.findMany.mockResolvedValue([]);
  });

  it("returns tracking result on happy path", async () => {
    getCourierEntryMock.mockReturnValue({
      name: "andreani",
      active: true,
      getAdapter: () => mockAdapter,
    });
    mockAdapter.create.mockResolvedValue(
      rpcOk({
        trackingNumber: "AND-12345",
        labelPdfUrl: "https://andreani.com/label/AND-12345.pdf",
        estimatedDelivery: "2026-06-05",
        service: "domicilio",
      }),
    );

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "create_shipment",
        arguments: {
          provider: "andreani",
          saleId: "sale-abc",
          customerName: "Juan",
          customerLastName: "Pérez",
          customerAddress: "Belgrano",
          customerAddressNumber: "123",
          customerPostalCode: "1001",
          weightGrams: 800,
        },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { trackingNumber: string };
      expect(parsed.trackingNumber).toBe("AND-12345");
    } finally {
      await cleanup();
    }
  });

  it("passes businessId from closure to adapter.create", async () => {
    getCourierEntryMock.mockReturnValue({
      name: "andreani",
      active: true,
      getAdapter: () => mockAdapter,
    });
    mockAdapter.create.mockResolvedValue(rpcOk({ trackingNumber: "AND-999" }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "create_shipment",
        arguments: {
          provider: "andreani",
          saleId: "sale-xyz",
          customerName: "Ana",
          customerAddress: "Rivadavia",
          customerPostalCode: "5500",
          weightGrams: 500,
        },
      });
      expect(mockAdapter.create).toHaveBeenCalledWith(
        expect.objectContaining({ saleId: "sale-xyz" }),
        BUSINESS_ID,
      );
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true for unknown provider", async () => {
    getCourierEntryMock.mockReturnValue(undefined); // unknown provider

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "create_shipment",
        arguments: {
          provider: "unknown-carrier",
          saleId: "sale-111",
          customerName: "Pedro",
          customerAddress: "San Martín",
          customerPostalCode: "5500",
          weightGrams: 300,
        },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toMatch(/desconocido/i);
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true when adapter returns a JSON-RPC error (credential absent)", async () => {
    getCourierEntryMock.mockReturnValue({
      name: "andreani",
      active: true,
      getAdapter: () => mockAdapter,
    });
    mockAdapter.create.mockResolvedValue(
      rpcErr("Andreani: credenciales no configuradas para este negocio"),
    );

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "create_shipment",
        arguments: {
          provider: "andreani",
          saleId: "sale-222",
          customerName: "María",
          customerAddress: "Córdoba",
          customerPostalCode: "5000",
          weightGrams: 600,
        },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(typeof parsed.error).toBe("string");
      expect(parsed.error.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});

// ── track_shipment ────────────────────────────────────────────────────────────

describe("track_shipment tool", () => {
  const BUSINESS_ID = "biz-track-001";

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.business.findUnique.mockResolvedValue({ ivaCondition: "Monotributista", courierPreference: null });
    prismaMock.courierCredential.findMany.mockResolvedValue([]);
  });

  it("returns tracking status and events on happy path", async () => {
    getCourierEntryMock.mockReturnValue({
      name: "andreani",
      active: true,
      getAdapter: () => mockAdapter,
    });
    mockAdapter.track.mockResolvedValue(
      rpcOk({
        trackingNumber: "AND-55555",
        currentStatus: "En camino",
        events: [
          { timestamp: "2026-06-01T10:00:00Z", status: "Recibido", description: "Paquete recibido en sucursal" },
          { timestamp: "2026-06-01T15:00:00Z", status: "En camino", description: "En reparto" },
        ],
      }),
    );

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "track_shipment",
        arguments: { trackingNumber: "AND-55555", provider: "andreani" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        trackingNumber: string;
        currentStatus: string;
        events: unknown[];
      };
      expect(parsed.trackingNumber).toBe("AND-55555");
      expect(parsed.currentStatus).toBe("En camino");
      expect(parsed.events).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("passes businessId from closure to adapter.track", async () => {
    getCourierEntryMock.mockReturnValue({
      name: "andreani",
      active: true,
      getAdapter: () => mockAdapter,
    });
    mockAdapter.track.mockResolvedValue(rpcOk({ trackingNumber: "T1", currentStatus: "ok", events: [] }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "track_shipment",
        arguments: { trackingNumber: "T1", provider: "andreani" },
      });
      expect(mockAdapter.track).toHaveBeenCalledWith(
        expect.objectContaining({ trackingNumber: "T1" }),
        BUSINESS_ID,
      );
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true for unknown provider", async () => {
    getCourierEntryMock.mockReturnValue(undefined);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "track_shipment",
        arguments: { trackingNumber: "T99", provider: "fedex" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toMatch(/desconocido/i);
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true when adapter returns a JSON-RPC error", async () => {
    getCourierEntryMock.mockReturnValue({
      name: "andreani",
      active: true,
      getAdapter: () => mockAdapter,
    });
    mockAdapter.track.mockResolvedValue(rpcErr("Andreani: tracking number not found"));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "track_shipment",
        arguments: { trackingNumber: "NOTFOUND-000", provider: "andreani" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(typeof parsed.error).toBe("string");
    } finally {
      await cleanup();
    }
  });
});
