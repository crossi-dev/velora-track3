// tests/vitest/mcp/cobro-status-tool.test.ts
//
// Unit tests for the open_cobro_status render tool (cobro-status-render.ts)
// and the getCobroDetail backend adapter method (velora-payments.adapter.ts).
//
// Uses InMemoryTransport.createLinkedPair() — mirrors pending-orders-tool.test.ts.
//
// Mocked dependencies:
//   - @/lib/prisma — paymentIntent.findFirst (via velora-payments.adapter.ts)
//   - resolveCustomerIdByName — fuzzy customer lookup
//
// Test groups:
//   1. Registration — open_cobro_status appears / not appears depending on businessId
//   2. Validation — neither id nor name → isError
//   3. estado → statusLabel mapping (all four estados)
//   4. UCP Order mapping — line_items price in minor units, totals, currency
//   5. Tenant scoping — businessId from closure, never from tool input
//   6. Not-found case — returns prefill.order = null (not isError)
//   7. Error handling — adapter throws → isError with COBRO_STATUS_ERROR

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { paymentIntentFindFirstMock, resolveCustomerIdByNameMock } = vi.hoisted(() => ({
  paymentIntentFindFirstMock: vi.fn(),
  resolveCustomerIdByNameMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentIntent: {
      findFirst: paymentIntentFindFirstMock,
      findMany: vi.fn().mockResolvedValue([]),
    },
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/payments-agent-helpers",
  () => ({ resolveCustomerIdByName: resolveCustomerIdByNameMock }),
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface UCPAmount { amount: number; currency: string }
interface UCPLineItem {
  id: string;
  item: { id: string; title: string; price: UCPAmount };
  quantity: number;
  status: string;
}
interface UCPOrder {
  id: string;
  line_items: UCPLineItem[];
  totals: Array<{ type: string; amount: number }>;
  currency: string;
  permalink_url?: string;
}
interface DisplayOrder {
  ucp: UCPOrder;
  customerName: string;
  statusLabel: string;
  estado: string;
  createdAt: string;
  confirmedAt: string | null;
}
interface TextContent { type: "text"; text: string }
interface CallToolResult { isError?: boolean; content: TextContent[]; structuredContent?: unknown }

function asToolResult(raw: unknown): CallToolResult {
  return raw as CallToolResult;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePI(overrides: Partial<{
  id: string;
  monto: number;
  estado: string;
  checkoutUrl: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  items: unknown;
  matchedCustomer: { name: string } | null;
  sale: {
    customer: { name: string } | null;
    saleItems: Array<{
      productId: string | null;
      quantity: number;
      unitPrice: number;
      product: { name: string } | null;
    }>;
  } | null;
}> = {}) {
  return {
    id: "pi-test-001",
    monto: 5000,
    estado: "pending",
    checkoutUrl: null,
    createdAt: new Date("2026-06-07T10:00:00.000Z"),
    confirmedAt: null,
    items: null,
    matchedCustomer: null,
    sale: null,
    ...overrides,
  };
}

const BUSINESS_ID = "biz-cobro-status-001";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── 1. Registration ───────────────────────────────────────────────────────────

describe("cobro-status tool — registration", () => {
  it("includes open_cobro_status when businessId is provided", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(null);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const result = await client.listTools();
      expect(result.tools.map((t) => t.name)).toContain("open_cobro_status");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include open_cobro_status when no businessId", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      expect(result.tools.map((t) => t.name)).not.toContain("open_cobro_status");
    } finally {
      await cleanup();
    }
  });
});

// ── 2. Input validation ───────────────────────────────────────────────────────

describe("open_cobro_status — input validation", () => {
  it("returns isError when neither paymentIntentId nor customerName is provided", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_cobro_status", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("missing_lookup_key");
    } finally {
      await cleanup();
    }
  });
});

// ── 3. estado → statusLabel mapping ──────────────────────────────────────────

describe("open_cobro_status — estado to statusLabel mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  const cases: Array<{ estado: string; expectedLabel: string }> = [
    { estado: "pending",   expectedLabel: "esperando_pago" },
    { estado: "confirmed", expectedLabel: "pagado" },
    { estado: "expired",   expectedLabel: "vencido" },
    { estado: "cancelled", expectedLabel: "cancelado" },
  ];

  for (const { estado, expectedLabel } of cases) {
    it(`maps estado="${estado}" → statusLabel="${expectedLabel}"`, async () => {
      // First findFirst: ownership check (returns the PI)
      // Second findFirst: full detail fetch
      paymentIntentFindFirstMock
        .mockResolvedValueOnce({ id: "pi-map-001" })       // ownership check
        .mockResolvedValueOnce(makePI({ id: "pi-map-001", estado })); // full detail

      const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
      try {
        const raw = await client.callTool({
          name: "open_cobro_status",
          arguments: { paymentIntentId: "pi-map-001" },
        });
        const result = asToolResult(raw);
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
        expect(sc.prefill.order.statusLabel).toBe(expectedLabel);
        expect(sc.prefill.order.estado).toBe(estado);
      } finally {
        await cleanup();
      }
    });
  }
});

// ── 4. UCP Order mapping ──────────────────────────────────────────────────────

describe("open_cobro_status — UCP Order mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps line_items with price.amount = pesos × 100 (minor units)", async () => {
    paymentIntentFindFirstMock
      .mockResolvedValueOnce({ id: "pi-ucp-001" })
      .mockResolvedValueOnce(
        makePI({
          id: "pi-ucp-001",
          estado: "pending",
          sale: {
            customer: { name: "Ana" },
            saleItems: [
              { productId: "p1", quantity: 2, unitPrice: 1500, product: { name: "Alfajor" } },
            ],
          },
        }),
      );

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_cobro_status",
        arguments: { paymentIntentId: "pi-ucp-001" },
      });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.ucp.line_items[0].item.price.amount).toBe(150000); // 1500 × 100
      expect(sc.prefill.order.ucp.line_items[0].item.price.currency).toBe("ARS");
    } finally {
      await cleanup();
    }
  });

  it("maps totals[0] type='total' with amount = totalARS × 100", async () => {
    paymentIntentFindFirstMock
      .mockResolvedValueOnce({ id: "pi-total-001" })
      .mockResolvedValueOnce(makePI({ id: "pi-total-001", monto: 7500 }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_cobro_status",
        arguments: { paymentIntentId: "pi-total-001" },
      });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      const totals = sc.prefill.order.ucp.totals;
      expect(totals[0].type).toBe("total");
      expect(totals[0].amount).toBe(750000); // 7500 × 100
    } finally {
      await cleanup();
    }
  });

  it("sets currency='ARS' on the UCP order", async () => {
    paymentIntentFindFirstMock
      .mockResolvedValueOnce({ id: "pi-cur-001" })
      .mockResolvedValueOnce(makePI({ id: "pi-cur-001" }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_cobro_status",
        arguments: { paymentIntentId: "pi-cur-001" },
      });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.ucp.currency).toBe("ARS");
    } finally {
      await cleanup();
    }
  });

  it("carries confirmedAt as ISO string when estado is confirmed", async () => {
    const confirmedAt = new Date("2026-06-06T14:22:00.000Z");
    paymentIntentFindFirstMock
      .mockResolvedValueOnce({ id: "pi-conf-001" })
      .mockResolvedValueOnce(makePI({ id: "pi-conf-001", estado: "confirmed", confirmedAt }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_cobro_status",
        arguments: { paymentIntentId: "pi-conf-001" },
      });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.confirmedAt).toBe(confirmedAt.toISOString());
    } finally {
      await cleanup();
    }
  });

  it("sets confirmedAt=null when not confirmed", async () => {
    paymentIntentFindFirstMock
      .mockResolvedValueOnce({ id: "pi-pend-001" })
      .mockResolvedValueOnce(makePI({ id: "pi-pend-001", estado: "pending", confirmedAt: null }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_cobro_status",
        arguments: { paymentIntentId: "pi-pend-001" },
      });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.confirmedAt).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

// ── 5. Tenant scoping ─────────────────────────────────────────────────────────

describe("open_cobro_status — tenant scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries paymentIntent with businessId from closure (not from tool args)", async () => {
    paymentIntentFindFirstMock
      .mockResolvedValueOnce({ id: "pi-tenant-001" })
      .mockResolvedValueOnce(makePI({ id: "pi-tenant-001" }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "open_cobro_status",
        arguments: { paymentIntentId: "pi-tenant-001" },
      });
      // Ownership check call must include closure businessId
      expect(paymentIntentFindFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ businessId: BUSINESS_ID }),
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("does NOT use a rogue businessId supplied in tool arguments", async () => {
    paymentIntentFindFirstMock
      .mockResolvedValueOnce({ id: "pi-rogue-001" })
      .mockResolvedValueOnce(makePI({ id: "pi-rogue-001" }));

    const OTHER_BIZ = "biz-rogue-attacker";
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "open_cobro_status",
        // Even if a rogue client passes businessId, it must be ignored
        arguments: { paymentIntentId: "pi-rogue-001", businessId: OTHER_BIZ } as Record<string, unknown>,
      });
      expect(paymentIntentFindFirstMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: OTHER_BIZ }) }),
      );
    } finally {
      await cleanup();
    }
  });
});

// ── 6. Not-found case ─────────────────────────────────────────────────────────

describe("open_cobro_status — not-found", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns prefill.order=null (not isError) when cobro is not found by id", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(null); // ownership check returns null

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_cobro_status",
        arguments: { paymentIntentId: "pi-does-not-exist" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: null } };
      expect(sc.prefill.order).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("returns prefill.order=null when customer name resolves but no PI found", async () => {
    resolveCustomerIdByNameMock.mockResolvedValue("cust-001");
    paymentIntentFindFirstMock.mockResolvedValue(null); // no PI for customer

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_cobro_status",
        arguments: { customerName: "Carlos" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: null } };
      expect(sc.prefill.order).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("returns prefill.order=null when customer name is not found", async () => {
    resolveCustomerIdByNameMock.mockResolvedValue(null); // customer not found

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_cobro_status",
        arguments: { customerName: "Nobody" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: null } };
      expect(sc.prefill.order).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

// ── 7. Error handling ─────────────────────────────────────────────────────────

describe("open_cobro_status — error handling", () => {
  it("returns isError: true with COBRO_STATUS_ERROR when backend throws", async () => {
    paymentIntentFindFirstMock.mockRejectedValue(new Error("DB timeout"));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_cobro_status",
        arguments: { paymentIntentId: "pi-throw-001" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("COBRO_STATUS_ERROR");
    } finally {
      await cleanup();
    }
  });
});
