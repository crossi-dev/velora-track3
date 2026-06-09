// tests/vitest/mcp/delivery-receipt-tool.test.ts
//
// Unit tests for the open_delivery_receipt render tool (delivery-receipt-render.ts)
// and the getDeliveryReceipt backend method (velora-delivery-receipt.ts).
//
// Uses InMemoryTransport.createLinkedPair() — mirrors cobro-status-tool.test.ts.
//
// Mocked dependencies:
//   - @/lib/prisma — paymentIntent.findFirst, sale.findFirst, andreaniShipment.findFirst,
//                    ocaShipment.findFirst (via velora-delivery-receipt.ts)
//   - resolveCustomerIdByName — fuzzy customer lookup
//
// Test groups:
//   1. Registration — open_delivery_receipt appears / not appears depending on businessId
//   2. Input validation — no id/sale/name → isError
//   3. comprobante kind selection:
//        a. factura when Invoice.caeCode is non-empty
//        b. comprobante when Invoice row exists but caeCode is null
//        c. comprobante when no Invoice row exists
//   4. envio present vs null:
//        a. Andreani shipment → envio with carrier="Andreani"
//        b. OCA shipment (Andreani null) → envio with carrier="OCA"
//        c. Neither shipment → envio=null in prefill
//   5. UCP Order mapping — line_items price in minor units, totals, currency, fulfillment
//   6. Tenant scoping — businessId from closure, rogue arg ignored
//   7. Not-found case — returns prefill.order=null (not isError)
//   8. Error handling — adapter throws → isError with DELIVERY_RECEIPT_ERROR

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  paymentIntentFindFirstMock,
  saleFindFirstMock,
  andreaniShipmentFindFirstMock,
  ocaShipmentFindFirstMock,
  resolveCustomerIdByNameMock,
} = vi.hoisted(() => ({
  paymentIntentFindFirstMock: vi.fn(),
  saleFindFirstMock: vi.fn(),
  andreaniShipmentFindFirstMock: vi.fn(),
  ocaShipmentFindFirstMock: vi.fn(),
  resolveCustomerIdByNameMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentIntent: {
      findFirst: paymentIntentFindFirstMock,
      findMany: vi.fn().mockResolvedValue([]),
    },
    sale: {
      findFirst: saleFindFirstMock,
    },
    andreaniShipment: {
      findFirst: andreaniShipmentFindFirstMock,
    },
    ocaShipment: {
      findFirst: ocaShipmentFindFirstMock,
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
interface UCPFulfillmentEvent {
  id: string;
  occurred_at: string;
  type: string;
  tracking_number: string;
  carrier: string;
  description: string;
}
interface UCPFulfillment {
  expectations: unknown[];
  events: UCPFulfillmentEvent[];
}
interface UCPOrder {
  id: string;
  line_items: UCPLineItem[];
  totals: Array<{ type: string; amount: number }>;
  currency: string;
  fulfillment: UCPFulfillment;
}
interface DeliveryComprobante {
  kind: "factura" | "comprobante";
  label: string;
  number?: string;
  pdfUrl?: string;
}
interface DeliveryEnvio {
  carrier: string;
  tracking?: string;
  status: string;
}
interface DisplayOrder {
  ucp: UCPOrder;
  customerName: string;
  comprobante: DeliveryComprobante;
  envio: DeliveryEnvio | null;
  estado: string;
}
interface TextContent { type: "text"; text: string }
interface CallToolResult { isError?: boolean; content: TextContent[]; structuredContent?: unknown }

function asToolResult(raw: unknown): CallToolResult {
  return raw as CallToolResult;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal PI row: saleId resolves to a sale. */
function makePI(saleId: string | null = "sale-001") {
  return { saleId };
}

/** Sale row with optional invoice. */
function makeSale(overrides: {
  id?: string;
  customerName?: string;
  items?: Array<{ productId: string | null; quantity: number; unitPrice: number; productName: string }>;
  caeCode?: string | null;
  hasInvoice?: boolean;
} = {}) {
  const {
    id = "sale-001",
    customerName = "Ana López",
    items = [{ productId: "p1", quantity: 2, unitPrice: 1500, productName: "Alfajor" }],
    caeCode = null,
    hasInvoice = true,
  } = overrides;

  const invoice = hasInvoice
    ? {
        invoiceNumber: "REC-0042",
        documentType: "receipt",
        caeCode: caeCode ?? null,
        fiscalNumero: caeCode ? 42 : null,
        fiscalPtoVta: caeCode ? 1 : null,
        fiscalTipo: caeCode ? 6 : null,   // 6 = Factura B
        fiscalQrUrl: caeCode ? "https://qr.afip.gob.ar/?p=example" : null,
        totalAmount: items.reduce((s, it) => s + it.quantity * it.unitPrice, 0),
        currency: "ARS",
      }
    : null;

  return {
    id,
    customer: { name: customerName },
    saleItems: items.map((it) => ({
      productId: it.productId,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      product: { name: it.productName },
    })),
    invoice,
  };
}

const BUSINESS_ID = "biz-delivery-receipt-001";

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

/** Default: no shipments. */
function setupNoShipments() {
  andreaniShipmentFindFirstMock.mockResolvedValue(null);
  ocaShipmentFindFirstMock.mockResolvedValue(null);
}

// ── 1. Registration ───────────────────────────────────────────────────────────

describe("delivery-receipt tool — registration", () => {
  it("includes open_delivery_receipt when businessId is provided", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(null);
    setupNoShipments();
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const result = await client.listTools();
      expect(result.tools.map((t) => t.name)).toContain("open_delivery_receipt");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include open_delivery_receipt when no businessId", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      expect(result.tools.map((t) => t.name)).not.toContain("open_delivery_receipt");
    } finally {
      await cleanup();
    }
  });
});

// ── 2. Input validation ───────────────────────────────────────────────────────

describe("open_delivery_receipt — input validation", () => {
  it("returns isError when no paymentIntentId, saleId, or customerName", async () => {
    setupNoShipments();
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_delivery_receipt", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("missing_lookup_key");
    } finally {
      await cleanup();
    }
  });
});

// ── 3. comprobante kind selection ─────────────────────────────────────────────

describe("open_delivery_receipt — comprobante kind selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupNoShipments();
  });

  it("kind='factura' when Invoice.caeCode is a non-empty string", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-factura"));
    saleFindFirstMock.mockResolvedValue(makeSale({ id: "sale-factura", caeCode: "12345678901234" }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-factura-001" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.comprobante.kind).toBe("factura");
      expect(sc.prefill.order.comprobante.label).toBe("Factura B");
      expect(sc.prefill.order.comprobante.number).toBe("0001-00000042");
    } finally {
      await cleanup();
    }
  });

  it("kind='comprobante' when Invoice row exists but caeCode is null", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-no-cae"));
    saleFindFirstMock.mockResolvedValue(makeSale({ id: "sale-no-cae", caeCode: null }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-no-cae-001" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.comprobante.kind).toBe("comprobante");
      expect(sc.prefill.order.comprobante.label).toBe("Comprobante de venta");
    } finally {
      await cleanup();
    }
  });

  it("kind='comprobante' when no Invoice row exists at all", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-no-invoice"));
    saleFindFirstMock.mockResolvedValue(makeSale({ id: "sale-no-invoice", hasInvoice: false }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-no-invoice-001" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.comprobante.kind).toBe("comprobante");
    } finally {
      await cleanup();
    }
  });
});

// ── 4. envio present vs null ──────────────────────────────────────────────────

describe("open_delivery_receipt — envio present vs null", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-envio-001"));
    saleFindFirstMock.mockResolvedValue(makeSale({ id: "sale-envio-001" }));
  });

  it("envio with carrier='Andreani' when AndreaniShipment row exists", async () => {
    andreaniShipmentFindFirstMock.mockResolvedValue({
      trackingNumber: "AND-0001234",
      status: "in_transit",
    });
    ocaShipmentFindFirstMock.mockResolvedValue(null);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-andreani-001" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.envio).not.toBeNull();
      expect(sc.prefill.order.envio?.carrier).toBe("Andreani");
      expect(sc.prefill.order.envio?.tracking).toBe("AND-0001234");
      expect(sc.prefill.order.envio?.status).toBe("in_transit");
    } finally {
      await cleanup();
    }
  });

  it("envio with carrier='OCA' when AndreaniShipment is null but OcaShipment exists", async () => {
    andreaniShipmentFindFirstMock.mockResolvedValue(null);
    ocaShipmentFindFirstMock.mockResolvedValue({
      trackingNumber: "OCA-9998877",
      status: "created",
    });

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-oca-001" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.envio?.carrier).toBe("OCA");
      expect(sc.prefill.order.envio?.tracking).toBe("OCA-9998877");
    } finally {
      await cleanup();
    }
  });

  it("envio=null when neither AndreaniShipment nor OcaShipment exists", async () => {
    andreaniShipmentFindFirstMock.mockResolvedValue(null);
    ocaShipmentFindFirstMock.mockResolvedValue(null);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-no-ship-001" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.envio).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

// ── 5. UCP Order mapping ──────────────────────────────────────────────────────

describe("open_delivery_receipt — UCP Order mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupNoShipments();
  });

  it("maps line_items with price.amount = unitPrice × 100 (minor units)", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-ucp-001"));
    saleFindFirstMock.mockResolvedValue(
      makeSale({
        id: "sale-ucp-001",
        items: [{ productId: "p1", quantity: 2, unitPrice: 1500, productName: "Alfajor" }],
      }),
    );

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-ucp-001" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.ucp.line_items[0].item.price.amount).toBe(150000); // 1500 × 100
      expect(sc.prefill.order.ucp.line_items[0].item.price.currency).toBe("ARS");
    } finally {
      await cleanup();
    }
  });

  it("maps totals[0] type='total' with amount = totalARS × 100", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-total-001"));
    saleFindFirstMock.mockResolvedValue(
      makeSale({
        id: "sale-total-001",
        items: [{ productId: "p1", quantity: 1, unitPrice: 5000, productName: "Producto" }],
      }),
    );

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-total-001" },
      });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      const totals = sc.prefill.order.ucp.totals;
      expect(totals[0].type).toBe("total");
      expect(totals[0].amount).toBe(500000); // 5000 × 100
    } finally {
      await cleanup();
    }
  });

  it("sets currency='ARS' on the UCP order", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-cur-001"));
    saleFindFirstMock.mockResolvedValue(makeSale({ id: "sale-cur-001" }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-cur-001" },
      });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.ucp.currency).toBe("ARS");
    } finally {
      await cleanup();
    }
  });

  it("fulfillment.events[] has tracking_number + carrier when Andreani shipment exists", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-fulfill-001"));
    saleFindFirstMock.mockResolvedValue(makeSale({ id: "sale-fulfill-001" }));
    andreaniShipmentFindFirstMock.mockResolvedValue({ trackingNumber: "AND-9999", status: "in_transit" });
    ocaShipmentFindFirstMock.mockResolvedValue(null);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-fulfill-001" },
      });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      const events = sc.prefill.order.ucp.fulfillment.events;
      expect(events).toHaveLength(1);
      expect(events[0].tracking_number).toBe("AND-9999");
      expect(events[0].carrier).toBe("Andreani");
      expect(events[0].type).toBe("shipment");
    } finally {
      await cleanup();
    }
  });

  it("fulfillment.events is empty [] when no shipment exists", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-nofulfill-001"));
    saleFindFirstMock.mockResolvedValue(makeSale({ id: "sale-nofulfill-001" }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-nofulfill-001" },
      });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: { order: DisplayOrder } };
      expect(sc.prefill.order.ucp.fulfillment.events).toHaveLength(0);
      expect(sc.prefill.order.ucp.fulfillment.expectations).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

// ── 6. Tenant scoping ─────────────────────────────────────────────────────────

describe("open_delivery_receipt — tenant scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupNoShipments();
  });

  it("queries with businessId from closure (not from tool args)", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-tenant-001"));
    saleFindFirstMock.mockResolvedValue(makeSale({ id: "sale-tenant-001" }));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-tenant-001" },
      });
      expect(paymentIntentFindFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ businessId: BUSINESS_ID }),
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("does NOT use a rogue businessId from tool arguments", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(makePI("sale-rogue-001"));
    saleFindFirstMock.mockResolvedValue(makeSale({ id: "sale-rogue-001" }));

    const OTHER_BIZ = "biz-rogue-attacker";
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "open_delivery_receipt",
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

// ── 7. Not-found case ─────────────────────────────────────────────────────────

describe("open_delivery_receipt — not-found", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupNoShipments();
  });

  it("returns prefill.order=null (not isError) when PI not found", async () => {
    paymentIntentFindFirstMock.mockResolvedValue(null);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
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

  it("returns prefill.order=null when saleId not found in Sale table", async () => {
    saleFindFirstMock.mockResolvedValue(null);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { saleId: "sale-does-not-exist" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: { order: null } };
      expect(sc.prefill.order).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("returns prefill.order=null when customer name not found", async () => {
    resolveCustomerIdByNameMock.mockResolvedValue(null);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
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

// ── 8. Error handling ─────────────────────────────────────────────────────────

describe("open_delivery_receipt — error handling", () => {
  it("returns isError: true with DELIVERY_RECEIPT_ERROR when backend throws", async () => {
    paymentIntentFindFirstMock.mockRejectedValue(new Error("DB timeout"));
    setupNoShipments();

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "open_delivery_receipt",
        arguments: { paymentIntentId: "pi-throw-001" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("DELIVERY_RECEIPT_ERROR");
    } finally {
      await cleanup();
    }
  });
});
