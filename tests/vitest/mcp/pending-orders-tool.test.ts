// tests/vitest/mcp/pending-orders-tool.test.ts
//
// Unit tests for the open_pending_orders render tool (payments-tools.ts)
// and the listPendingOrders backend adapter method (velora-payments.adapter.ts).
//
// Uses InMemoryTransport.createLinkedPair() — mirrors catalog-selector-tool.test.ts.
//
// Mocked dependencies:
//   - @/lib/prisma — paymentIntent.findMany (via velora-payments.adapter.ts)
//   - All other prisma models stubbed to avoid unrelated DB calls
//
// Test groups:
//   1. Registration — open_pending_orders appears / not appears depending on businessId
//   2. UCP Order mapping — line_items, totals, currency, permalink_url
//   3. Tenant scoping — businessId from closure, never from tool input
//   4. Empty list — widget receives empty orders array
//   5. Backend adapter — prisma where includes { businessId, estado: "pending" }
//   6. Customer name resolution — sale.customer → matchedCustomer → "Desconocido"
//   7. Items from SaleItems vs standalone PI.items JSON blob
//   8. Error handling — adapter throws → isError response

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { paymentIntentFindManyMock } = vi.hoisted(() => ({
  paymentIntentFindManyMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentIntent: { findMany: paymentIntentFindManyMock, findFirst: vi.fn().mockResolvedValue(null) },
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

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
  createdAt: string;
  status: string;
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
  checkoutUrl: string | null;
  createdAt: Date;
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
    id: "pi-001",
    monto: 3500,
    checkoutUrl: null,
    createdAt: new Date("2026-06-07T10:00:00.000Z"),
    items: null,
    matchedCustomer: null,
    sale: null,
    ...overrides,
  };
}

const BUSINESS_ID = "biz-pending-001";

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

// ── Registration ──────────────────────────────────────────────────────────────

describe("pending orders tool — registration", () => {
  it("includes open_pending_orders when businessId is provided", async () => {
    paymentIntentFindManyMock.mockResolvedValue([]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("open_pending_orders");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include open_pending_orders when no businessId", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("open_pending_orders");
    } finally {
      await cleanup();
    }
  });
});

// ── UCP Order mapping ─────────────────────────────────────────────────────────

describe("open_pending_orders — UCP Order mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps line_items with item.price.amount = pesos × 100", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({
        id: "pi-ucp-1",
        monto: 3500,
        sale: {
          customer: { name: "Carlos" },
          saleItems: [
            { productId: "prod-1", quantity: 2, unitPrice: 1500, product: { name: "Alfajor" } },
            { productId: "prod-2", quantity: 1, unitPrice: 500, product: { name: "Agua" } },
          ],
        },
      }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      const order = sc.prefill.orders[0];
      expect(order.ucp.line_items).toHaveLength(2);
      expect(order.ucp.line_items[0].item.price.amount).toBe(150000);  // 1500 × 100
      expect(order.ucp.line_items[0].item.price.currency).toBe("ARS");
      expect(order.ucp.line_items[1].item.price.amount).toBe(50000);   // 500 × 100
    } finally {
      await cleanup();
    }
  });

  it("maps totals[0] type='total' with amount = totalARS × 100", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({ id: "pi-total", monto: 4500 }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      const totals = sc.prefill.orders[0].ucp.totals;
      expect(totals[0].type).toBe("total");
      expect(totals[0].amount).toBe(450000);  // 4500 × 100
    } finally {
      await cleanup();
    }
  });

  it("sets currency='ARS' on the UCP order", async () => {
    paymentIntentFindManyMock.mockResolvedValue([makePI()]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders[0].ucp.currency).toBe("ARS");
    } finally {
      await cleanup();
    }
  });

  it("sets permalink_url when checkoutUrl is present", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({ checkoutUrl: "https://mpago.la/test-link" }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders[0].ucp.permalink_url).toBe("https://mpago.la/test-link");
    } finally {
      await cleanup();
    }
  });

  it("omits permalink_url when checkoutUrl is null", async () => {
    paymentIntentFindManyMock.mockResolvedValue([makePI({ checkoutUrl: null })]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders[0].ucp.permalink_url).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("maps line_items status = 'processing'", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({
        sale: {
          customer: null,
          saleItems: [
            { productId: "p1", quantity: 1, unitPrice: 1000, product: { name: "Test" } },
          ],
        },
      }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders[0].ucp.line_items[0].status).toBe("processing");
    } finally {
      await cleanup();
    }
  });

  it("carries customerName as a display extension alongside the UCP order", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({ sale: { customer: { name: "Ana López" }, saleItems: [] } }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders[0].customerName).toBe("Ana López");
    } finally {
      await cleanup();
    }
  });

  it("carries createdAt as ISO string as a display extension", async () => {
    const dt = new Date("2026-06-07T12:00:00.000Z");
    paymentIntentFindManyMock.mockResolvedValue([makePI({ createdAt: dt })]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders[0].createdAt).toBe(dt.toISOString());
    } finally {
      await cleanup();
    }
  });
});

// ── Tenant scoping ────────────────────────────────────────────────────────────

describe("open_pending_orders — tenant scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries paymentIntent with businessId from closure and estado='pending'", async () => {
    paymentIntentFindManyMock.mockResolvedValue([]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({ name: "open_pending_orders", arguments: {} });
      expect(paymentIntentFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            businessId: BUSINESS_ID,
            estado: "pending",
          }),
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("does NOT use businessId from tool arguments — closure wins", async () => {
    paymentIntentFindManyMock.mockResolvedValue([]);
    const OTHER_BIZ = "biz-other-rogue";
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      // Rogue client passes a different businessId in args — must be ignored
      await client.callTool({ name: "open_pending_orders", arguments: { businessId: OTHER_BIZ } });
      expect(paymentIntentFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: BUSINESS_ID }) }),
      );
      expect(paymentIntentFindManyMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: OTHER_BIZ }) }),
      );
    } finally {
      await cleanup();
    }
  });
});

// ── Empty list ────────────────────────────────────────────────────────────────

describe("open_pending_orders — empty list", () => {
  it("returns structuredContent.prefill.orders = [] when no pending intents", async () => {
    paymentIntentFindManyMock.mockResolvedValue([]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

// ── Customer name resolution ──────────────────────────────────────────────────

describe("open_pending_orders — customer name resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses sale.customer.name when sale and customer are present", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({
        matchedCustomer: { name: "Matched Name" },
        sale: { customer: { name: "Sale Customer" }, saleItems: [] },
      }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      // sale.customer.name wins over matchedCustomer
      expect(sc.prefill.orders[0].customerName).toBe("Sale Customer");
    } finally {
      await cleanup();
    }
  });

  it("falls back to matchedCustomer.name when sale has no customer", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({
        matchedCustomer: { name: "Matched Customer" },
        sale: { customer: null, saleItems: [] },
      }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders[0].customerName).toBe("Matched Customer");
    } finally {
      await cleanup();
    }
  });

  it("falls back to 'Desconocido' when no customer info is available", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({ matchedCustomer: null, sale: null }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders[0].customerName).toBe("Desconocido");
    } finally {
      await cleanup();
    }
  });
});

// ── Items: SaleItems vs standalone PI JSON blob ───────────────────────────────

describe("open_pending_orders — items source", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses Sale.saleItems when sale is linked", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({
        items: [{ productName: "PI Item", quantity: 5, unitPrice: 100, subtotal: 500 }],
        sale: {
          customer: { name: "Test" },
          saleItems: [
            { productId: "prod-a", quantity: 2, unitPrice: 750, product: { name: "SaleItem" } },
          ],
        },
      }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      const items = sc.prefill.orders[0].ucp.line_items;
      // Must use saleItems, not PI.items
      expect(items).toHaveLength(1);
      expect(items[0].item.title).toBe("SaleItem");
      expect(items[0].quantity).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("falls back to PI.items JSON blob when no sale is linked", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({
        items: [
          { productName: "Blob Item", quantity: 3, unitPrice: 200, subtotal: 600 },
        ],
        sale: null,
      }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      const items = sc.prefill.orders[0].ucp.line_items;
      expect(items).toHaveLength(1);
      expect(items[0].item.title).toBe("Blob Item");
      expect(items[0].quantity).toBe(3);
      expect(items[0].item.price.amount).toBe(20000);  // 200 × 100
    } finally {
      await cleanup();
    }
  });

  it("returns empty line_items when PI has no sale and no items blob", async () => {
    paymentIntentFindManyMock.mockResolvedValue([
      makePI({ items: null, sale: null }),
    ]);
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { orders: DisplayOrder[] } };
      expect(sc.prefill.orders[0].ucp.line_items).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("open_pending_orders — error handling", () => {
  it("returns isError: true when backend throws", async () => {
    paymentIntentFindManyMock.mockRejectedValue(new Error("DB timeout"));
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_pending_orders", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PENDING_ORDERS_ERROR");
    } finally {
      await cleanup();
    }
  });
});
