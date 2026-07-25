// tests/vitest/mcp/fiscal-mcp-server.test.ts
//
// Unit tests for the Velora fiscal MCP server factory (Phase 1 + Phase 2).
// Uses InMemoryTransport.createLinkedPair() from the MCP SDK to wire a Client
// to the McpServer without any HTTP overhead, exercising the full tool dispatch
// path end-to-end within the same process.
//
// Phase 2 tests cover stateful tools (get_fiscal_readiness, emit_invoice).
// Prisma and emit() are mocked — no real DB or ARCA calls are made.
//
// Pre-existing vitest failures on main (sale-post-commit-chain, employee-auth-edge)
// are unrelated — verify this file's pass count independently.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Phase 2 mocks ─────────────────────────────────────────────────────────────
//
// We mock the two I/O dependencies used by the stateful fiscal tools:
//   1. @/lib/prisma  — business.findUnique + arcaCredential.findUnique
//   2. arca-real/emit-invoice — emit() (routes real vs sandbox by env + credential)
//   3. prisma-idempotency.adapter — returns "execute" by default so the idempotency
//      layer added to VeloraFiscalAdapter is transparent for these integration tests.
//      Dedicated idempotency behavior is covered in fiscal-adapter-idempotency.test.ts.
//
// vi.hoisted() runs before module graph resolution — required so the mock
// factories can reference the mock fns before vi.mock() calls.

const {
  prismaMock,
  emitMock,
  isBusinessDemoTesterMock,
  idempotencyAdapterMock,
} = vi.hoisted(() => ({
  prismaMock: {
    business: {
      findUnique: vi.fn(),
    },
    arcaCredential: {
      findUnique: vi.fn(),
    },
    product: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Stubs for customer-tools, logistica-tools, and sale-confirm-render registered alongside fiscal tools
    customer: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    courierCredential: { findMany: vi.fn().mockResolvedValue([]) },
    saleItem: { findMany: vi.fn().mockResolvedValue([]) },
    paymentIntent: { findFirst: vi.fn().mockResolvedValue(null) },
    // Stub for resolveTenantBackendMap — null = all env / "velora" defaults
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
  emitMock: vi.fn(),
  isBusinessDemoTesterMock: vi.fn().mockResolvedValue(false),
  // Transparent stub: always returns "execute" with a dummy recordId so
  // the idempotency wrapper in VeloraFiscalAdapter does not interfere with
  // existing emit_invoice / emit_nota tests. The adapter calls begin/complete
  // but these tests only care about what emit() receives and returns.
  idempotencyAdapterMock: {
    begin: vi.fn().mockResolvedValue({ kind: "execute", recordId: "test-record-id" }),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock(
  "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice",
  async (importOriginal) => {
    // Preserve pure exports (sandboxEmit, resolveInvoiceType, splitIva21)
    // — only replace emit() so tool normalisation still works end-to-end.
    const original =
      await importOriginal<
        typeof import("@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice")
      >();
    return { ...original, emit: emitMock };
  },
);

vi.mock("@/lib/demo-testers", () => ({
  isBusinessDemoTester: isBusinessDemoTesterMock,
}));

// Transparent idempotency adapter stub — makes the VeloraFiscalAdapter idempotency
// layer invisible to these end-to-end tool tests (execute path always selected).
vi.mock("@/infrastructure/persistence/prisma-idempotency.adapter", () => ({
  prismaIdempotencyAdapter: idempotencyAdapterMock,
}));

// Stubs for new Batch 2 tool dependencies
vi.mock("@/infrastructure/shared/customer-mutations", () => ({
  createCustomerInTransaction: vi.fn(),
  updateCustomerInTransaction: vi.fn(),
}));

vi.mock(
  "@/app/api/agents/logistica/jsonrpc/_lib/courier-registry",
  () => ({
    COURIER_REGISTRY: [],
    getCourierEntry: vi.fn().mockReturnValue(null),
    getActiveCourierNames: () => [],
  }),
);

// ── Types ──────────────────────────────────────────────────────────────────────

interface TextContent {
  type: "text";
  text: string;
}

interface CallToolResult {
  isError?: boolean;
  content: TextContent[];
}

// callTool returns { [x: string]: unknown; content: ... } — the index signature
// forces TypeScript to widen `content` to `unknown`. This typed helper narrows
// the result back to the shape we need for assertions.
// ts-expect-error would be too broad; explicit cast is the minimal correct fix.
function asToolResult(raw: unknown): CallToolResult {
  return raw as CallToolResult;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function buildConnectedClient(businessId?: string, packs?: string[]): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await buildVeloraMcpServer(businessId, packs);
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

// ── connection / onboarding pack isolation boundary ───────────────────────────
//
// Pins the deliberate split introduced when open_onboarding was moved OUT of the
// onboarding pack and INTO the connection pack:
//
//   connection  → read-only hub tools (connection_status + open_onboarding)
//   onboarding  → credential write tools (connect_* + upload_catalog)
//
// The v1 connector ships with ["connection"] ONLY, giving it the graphical hub
// without exposing raw-credential tools.  Any future wants() drift that collapses
// this boundary will be caught immediately by the assertions below.

describe("buildVeloraMcpServer — connection/onboarding pack isolation", () => {
  it("connection pack includes open_onboarding + connection_status and excludes credential tools", async () => {
    const { client, cleanup } = await buildConnectedClient("biz", ["connection"]);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // Graphical hub tools must be present
      expect(names).toContain("open_onboarding");
      expect(names).toContain("connection_status");
      // Credential write tools must be absent
      expect(names).not.toContain("connect_mercadopago");
      expect(names).not.toContain("connect_pedidosya");
      expect(names).not.toContain("connect_whatsapp");
      expect(names).not.toContain("upload_catalog");
    } finally {
      await cleanup();
    }
  });

  it("onboarding pack includes credential tools and excludes open_onboarding", async () => {
    const { client, cleanup } = await buildConnectedClient("biz", ["onboarding"]);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // Credential write tools must be present
      expect(names).toContain("connect_mercadopago");
      expect(names).toContain("connect_pedidosya");
      expect(names).toContain("connect_whatsapp");
      expect(names).toContain("upload_catalog");
      // Graphical hub (connection pack) must be absent
      expect(names).not.toContain("open_onboarding");
    } finally {
      await cleanup();
    }
  });
});

describe("buildVeloraMcpServer — pack selection (toolset filtering)", () => {
  it("registers ONLY the requested pack (+ always-on validate_cuit)", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-packs", ["payments"]);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("validate_cuit"); // Pure pack — always on
      expect(names).toContain("get_payment_intent_status"); // payments pack
      expect(names).toContain("create_tracked_payment_link"); // payments pack
      // tools from OTHER packs must be absent
      expect(names).not.toContain("register_sale"); // sales pack
      expect(names).not.toContain("query_catalog"); // ventas pack
      expect(names).not.toContain("emit_invoice"); // fiscal pack
      expect(names).not.toContain("ask_velora"); // meta pack removed
    } finally { await cleanup(); }
  });

  it("combines multiple requested packs", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-packs", ["payments", "ventas"]);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("get_payment_intent_status"); // payments
      expect(names).toContain("query_catalog"); // ventas
      expect(names).not.toContain("register_sale"); // sales — not requested
    } finally { await cleanup(); }
  });

  it("registers ALL packs when none specified (backward-compatible default)", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-packs");
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("register_sale");
      expect(names).toContain("emit_invoice");
      expect(names).toContain("get_payment_intent_status");
    } finally { await cleanup(); }
  });
});

// ── server identity (FIX 6) ───────────────────────────────────────────────────

describe("buildVeloraMcpServer — server name", () => {
  it("reports name as velora-mcp (not velora-fiscal)", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      // The MCP initialize handshake returns serverInfo.name.
      // InMemoryTransport completes the handshake on connect() — server info is
      // available via getServerVersion() after the client connects.
      const info = client.getServerVersion();
      expect(info?.name).toBe("velora-mcp");
    } finally {
      await cleanup();
    }
  });
});

// ── tools/list ─────────────────────────────────────────────────────────────────

describe("buildVeloraMcpServer — tools/list", () => {
  it("registers exactly one tool when no businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "validate_cuit",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("registers forty-seven tools when a businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "adjust_stock",
        "bulk_price_update",
        "caja_ciclo_caja",
        "caja_consultar_saldo",
        "caja_registrar_movimiento",
        "connect_mercadopago",
        "connect_pedidosya",
        "connect_whatsapp",
        "connection_status",
        "create_product",
        "create_purchase_request",
        "create_shipment",
        "create_supplier",
        "create_tracked_payment_link",
        "delete_customer",
        "delete_product",
        "delete_supplier",
        "edit_product",
        "edit_supplier",
        "emit_invoice",
        "emit_nota",
        "find_customer",
        "get_fiscal_readiness",
        "get_package_profile",
        "get_payment_intent_status",
        "list_suppliers",
        "open_caja_status",
        "open_catalog_selector",
        "open_cobro_status",
        "open_delivery_receipt",
        "open_onboarding",
        "open_payment_link_wizard",
        "open_pending_orders",
        "open_sale_confirm",
        "query_catalog",
        "query_sales",
        "quote_shipping",
        "register_movement",
        "register_sale",
        "return_sale",
        "send_whatsapp_template",
        "send_whatsapp_text",
        "stock_load",
        "track_shipment",
        "upload_catalog",
        "upsert_customer",
        "validate_cuit",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("validate_cuit has a description and inputSchema", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "validate_cuit");
      expect(tool).toBeDefined();
      expect(tool?.description).toContain("CUIT");
      expect(tool?.inputSchema).toBeDefined();
    } finally {
      await cleanup();
    }
  });

});


// ── validate_cuit ──────────────────────────────────────────────────────────────

describe("validate_cuit tool", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const conn = await buildConnectedClient();
    client = conn.client;
    cleanup = conn.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("returns valid=true for a correct CUIT (20-05536168-2)", async () => {
    const raw = await client.callTool({
      name: "validate_cuit",
      arguments: { cuit: "20055361682" },
    });
    const result = asToolResult(raw);

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text) as {
      valid: boolean;
      prefix: string;
      personType: string;
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.prefix).toBe("20");
    expect(parsed.personType).toBe("fisica_masculina");
  });

  it("returns valid=false with error for an 11-digit CUIT with wrong check digit", async () => {
    const raw = await client.callTool({
      name: "validate_cuit",
      arguments: { cuit: "20055361689" }, // correct check digit is 2
    });
    const result = asToolResult(raw);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as {
      valid: boolean;
      error: string;
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.error).toMatch(/dígito verificador/i);
  });

  it("returns valid=false with error for a CUIT with wrong length", async () => {
    const raw = await client.callTool({
      name: "validate_cuit",
      arguments: { cuit: "123" },
    });
    const result = asToolResult(raw);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as {
      valid: boolean;
      error: string;
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.error).toMatch(/dígitos/i);
  });

  it("accepts hyphened format and strips non-digits correctly", async () => {
    const raw = await client.callTool({
      name: "validate_cuit",
      arguments: { cuit: "20-05536168-2" },
    });
    const result = asToolResult(raw);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as {
      valid: boolean;
      normalized: string;
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.normalized).toBe("20055361682");
  });

  it("includes personTypeDescription in the output", async () => {
    const raw = await client.callTool({
      name: "validate_cuit",
      arguments: { cuit: "20055361682" },
    });
    const result = asToolResult(raw);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as {
      personTypeDescription: string;
    };
    expect(parsed.personTypeDescription).toBeDefined();
    expect(typeof parsed.personTypeDescription).toBe("string");
  });
});

// ── get_fiscal_readiness (Phase 2) ────────────────────────────────────────────

describe("get_fiscal_readiness tool", () => {
  const BUSINESS_ID = "biz-test-001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ready=false with missing list when business has no cuit", async () => {
    prismaMock.business.findUnique.mockResolvedValue({
      cuit: null,
      ivaCondition: "Monotributista",
      puntoVenta: "1",
    });
    prismaMock.arcaCredential.findUnique.mockResolvedValue({ businessId: BUSINESS_ID });

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "get_fiscal_readiness", arguments: {} });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        ready: boolean;
        missing: string[];
        guidance: string;
      };
      expect(parsed.ready).toBe(false);
      expect(parsed.missing.length).toBeGreaterThan(0);
      expect(parsed.guidance).toContain("ARCA");
    } finally {
      await cleanup();
    }
  });

  it("returns ready=true when all fiscal fields and credential are present", async () => {
    prismaMock.business.findUnique.mockResolvedValue({
      cuit: "30055361685",
      ivaCondition: "Monotributista",
      puntoVenta: "3",
    });
    prismaMock.arcaCredential.findUnique.mockResolvedValue({ businessId: BUSINESS_ID });

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "get_fiscal_readiness", arguments: {} });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        ready: boolean;
        missing: string[];
        guidance: string;
      };
      expect(parsed.ready).toBe(true);
      expect(parsed.missing).toHaveLength(0);
      expect(parsed.guidance).toBe("");
    } finally {
      await cleanup();
    }
  });

  it("is not registered when no businessId is supplied", async () => {
    const { client, cleanup } = await buildConnectedClient(); // no businessId
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("get_fiscal_readiness");
    } finally {
      await cleanup();
    }
  });
});

// ── emit_invoice (Phase 2) ────────────────────────────────────────────────────

describe("emit_invoice tool", () => {
  const BUSINESS_ID = "biz-test-002";

  const SANDBOX_EMIT_RESULT = {
    sandbox: true as const,
    cae: "12345678901234",
    vencimiento: "20260611",
    tipo: "C" as const,
    numero: 12345,
    customerCuit: "20055361682",
    amountARS: 1000,
    concept: "Productos y/o servicios",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: business has ivaCondition set (used for type correction)
    prismaMock.business.findUnique.mockResolvedValue({
      ivaCondition: "Monotributista",
    });
    // Default: emit() returns a sandbox result (ARCA_REAL_MODE unset)
    emitMock.mockResolvedValue(SANDBOX_EMIT_RESULT);
    // Restore transparent idempotency stubs after vi.clearAllMocks().
    idempotencyAdapterMock.begin.mockResolvedValue({ kind: "execute", recordId: "test-record-id" });
    idempotencyAdapterMock.complete.mockResolvedValue(undefined);
    idempotencyAdapterMock.release.mockResolvedValue(undefined);
  });

  it("returns a normalised sandbox result with sandbox=true", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "emit_invoice",
        arguments: {
          customerCuit: "20055361682",
          amountARS: 1000,
          tipo: "C",
        },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        sandbox: boolean;
        cae: string;
        tipo: string;
        numero: number;
        customerCuit: string;
        amountARS: number;
      };
      expect(parsed.sandbox).toBe(true);
      expect(parsed.cae).toBe("12345678901234");
      expect(parsed.tipo).toBe("C");
      expect(parsed.customerCuit).toBe("20055361682");
      expect(parsed.amountARS).toBe(1000);
    } finally {
      await cleanup();
    }
  });

  it("passes ivaCondition from business row to emit()", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "emit_invoice",
        arguments: { customerCuit: "20055361682", amountARS: 500, tipo: "B" },
      });
      expect(emitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          condicionIva: "Monotributista",
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("uses default concept when none is supplied", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "emit_invoice",
        arguments: { customerCuit: "20055361682", amountARS: 200, tipo: "C" },
      });
      expect(emitMock).toHaveBeenCalledWith(
        expect.objectContaining({ concept: "Productos y/o servicios" }),
      );
    } finally {
      await cleanup();
    }
  });

  it("is not registered when no businessId is supplied", async () => {
    const { client, cleanup } = await buildConnectedClient(); // no businessId
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("emit_invoice");
    } finally {
      await cleanup();
    }
  });

  // FIX 1: emit() throws → isError with EMIT_FAILED code, no raw stack.
  it("returns isError: true with EMIT_FAILED when emit() throws", async () => {
    emitMock.mockRejectedValue(new Error("WSFE SOAP timeout: conexión rechazada"));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "emit_invoice",
        arguments: { customerCuit: "20055361682", amountARS: 1000, tipo: "C" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe("EMIT_FAILED");
      expect(parsed.message).toBe("WSFE SOAP timeout: conexión rechazada");
      // Must NOT contain a stack trace.
      expect(parsed.message).not.toMatch(/at Object\./);
    } finally {
      await cleanup();
    }
  });
});

// ── emit_nota (Phase 3) ───────────────────────────────────────────────────────

describe("emit_nota tool", () => {
  const BUSINESS_ID = "biz-test-003";

  const SANDBOX_NC_RESULT = {
    sandbox: true as const,
    cae: "98765432109876",
    vencimiento: "20260611",
    tipo: "C" as const,
    numero: 54321,
    customerCuit: "20055361682",
    amountARS: 500,
    concept: "Nota de crédito",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.business.findUnique.mockResolvedValue({
      ivaCondition: "Monotributista",
    });
    emitMock.mockResolvedValue(SANDBOX_NC_RESULT);
    // Restore transparent idempotency stubs after vi.clearAllMocks().
    idempotencyAdapterMock.begin.mockResolvedValue({ kind: "execute", recordId: "test-record-id" });
    idempotencyAdapterMock.complete.mockResolvedValue(undefined);
    idempotencyAdapterMock.release.mockResolvedValue(undefined);
  });

  it("returns a sandbox NC result with sandbox=true", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "emit_nota",
        arguments: {
          customerCuit: "20055361682",
          amountARS: 500,
          tipo: "C",
          kind: "credito",
          associatedInvoice: { tipo: "11", ptoVta: 1, nro: 42 },
        },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        sandbox: boolean;
        cae: string;
        tipo: string;
        numero: number;
      };
      expect(parsed.sandbox).toBe(true);
      expect(parsed.cae).toBe("98765432109876");
      expect(parsed.tipo).toBe("C");
    } finally {
      await cleanup();
    }
  });

  it("passes noteKind and cbteAsoc to emit()", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "emit_nota",
        arguments: {
          customerCuit: "20055361682",
          amountARS: 300,
          tipo: "B",
          kind: "debito",
          associatedInvoice: { tipo: "6", ptoVta: 2, nro: 99 },
        },
      });
      expect(emitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          noteKind: "debito",
          cbteAsoc: { tipo: 6, ptoVta: 2, nro: 99 },
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("is not registered when no businessId is supplied", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("emit_nota");
    } finally {
      await cleanup();
    }
  });

  // FIX 1: emit() throws in emit_nota → isError with EMIT_FAILED, no stack trace.
  it("returns isError: true with EMIT_FAILED when emit() throws in emit_nota", async () => {
    emitMock.mockRejectedValue(new Error("ARCA credential expired"));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "emit_nota",
        arguments: {
          customerCuit: "20055361682",
          amountARS: 200,
          tipo: "C",
          kind: "credito",
          associatedInvoice: { tipo: "11", ptoVta: 1, nro: 10 },
        },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe("EMIT_FAILED");
      expect(parsed.message).toBe("ARCA credential expired");
    } finally {
      await cleanup();
    }
  });

  // FIX 2: associatedInvoice.tipo must be 1, 6, or 11 — other ints rejected.
  it("rejects associatedInvoice.tipo that is not 1, 6, or 11", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      // tipo: 3 is a Nota Crédito A code — not a valid original FACTURA code.
      // MCP SDK returns isError: true with validation error — does not throw.
      const raw = await client.callTool({
        name: "emit_nota",
        arguments: {
          customerCuit: "20055361682",
          amountARS: 100,
          tipo: "A",
          kind: "credito",
          associatedInvoice: { tipo: "3", ptoVta: 1, nro: 1 },
        },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("invalid_enum_value");
    } finally {
      await cleanup();
    }
  });

  // FIX 2: confirm that valid tipo values 1, 6, 11 are accepted.
  it.each([
    { tipo: "1", label: "Factura A" },
    { tipo: "6", label: "Factura B" },
    { tipo: "11", label: "Factura C" },
  ])("accepts associatedInvoice.tipo=$tipo ($label)", async ({ tipo }) => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "emit_nota",
        arguments: {
          customerCuit: "20055361682",
          amountARS: 150,
          tipo: "C",
          kind: "credito",
          associatedInvoice: { tipo, ptoVta: 1, nro: 5 },
        },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });
});
