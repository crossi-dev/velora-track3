// tests/vitest/mcp/payment-link-wizard-seam.test.ts
//
// Unit tests for the PaymentsBackend.createTrackedPaymentLink port method.
//
// Strategy: test via the MCP tool layer (buildVeloraMcpServer + InMemoryTransport),
// injecting a mock backend through the registerPaymentsTools `backend` parameter.
// This validates:
//   1. The tool handler correctly delegates to backend.createTrackedPaymentLink.
//   2. Validation in the tool handler blocks before the port (missing fields).
//   3. The domain Result → MCP response mapping is correct for all discriminants.
//   4. businessId comes from the closure, not from tool input.
//
// For adapter-level tests (NABAOS, idempotency, MP sentinels) we test
// createTrackedPaymentLinkImpl directly by mocking its dependencies.
//
// Tests:
//   Tool layer (via MCP transport):
//     - missing customerId → isError validation
//     - missing idempotencyKey → isError validation
//     - backend success → structuredContent paymentLinkUrl + paymentIntentId + amountARS
//     - domain error mp_not_connected → isError with correct code
//     - domain error mp_token_expired → isError with correct code
//     - domain error mp_decrypt_error → isError with correct code
//     - domain error payment_links_blocked → isError with correct code
//     - businessId from closure (not from args)
//
//   Adapter-level (createTrackedPaymentLinkImpl):
//     - NABAOS: total comes from use-case grandTotal (not model-supplied)
//     - idempotencyKey dedups: replayed outcome → orphan-heal path
//     - alias-missing (payment_links_blocked) → domainError discriminant
//     - MP sentinel "payment_provider_not_connected" → domainError "mp_not_connected"
//     - MP sentinel "payment_provider_token_expired"  → domainError "mp_token_expired"
//     - MP sentinel "payment_token_decrypt_error"    → domainError "mp_decrypt_error"
//     - unexpected MP error → domainError "mp_api_error"

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PaymentsBackend, CreateTrackedPaymentLinkResult } from "@/lib/mcp/_lib/payments-backend.port";

// ── Mocks for adapter-level tests ────────────────────────────────────────────

const {
  registerSaleWithPaymentLinkUseCaseMock,
  getPaymentProviderMock,
  healOrphanedIntentMock,
  resolveSaleItemsForPreferenceMock,
  getMissingBusinessDataMock,
  isAutoApprovalEnabledMock,
  prismaBusinessFindUniqueMock,
  prismaPaymentIntentFindUniqueMock,
} = vi.hoisted(() => {
  const mockAdapter = { createCollection: vi.fn() };
  return {
    registerSaleWithPaymentLinkUseCaseMock: vi.fn(),
    getPaymentProviderMock: vi.fn().mockResolvedValue(mockAdapter),
    healOrphanedIntentMock: vi.fn(),
    resolveSaleItemsForPreferenceMock: vi.fn().mockResolvedValue({ items: null }),
    getMissingBusinessDataMock: vi.fn().mockReturnValue({ paymentLinks: { blocked: false, ownerPrompt: "" } }),
    isAutoApprovalEnabledMock: vi.fn().mockResolvedValue(false),
    prismaBusinessFindUniqueMock: vi.fn(),
    prismaPaymentIntentFindUniqueMock: vi.fn(),
  };
});

vi.mock(
  "@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case",
  () => ({ registerSaleWithPaymentLinkUseCase: registerSaleWithPaymentLinkUseCaseMock }),
);
vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/payment-provider",
  () => ({ getPaymentProvider: getPaymentProviderMock }),
);
vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/payment-link-orphan-heal",
  () => ({ healOrphanedIntent: healOrphanedIntentMock }),
);
vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/mp-preference-sale-items",
  () => ({ resolveSaleItemsForPreference: resolveSaleItemsForPreferenceMock }),
);
vi.mock(
  "@velora/core-utils/missing-business-data",
  () => ({ getMissingBusinessData: getMissingBusinessDataMock }),
);
vi.mock(
  "@/lib/mcp/_lib/approval-gate",
  () => ({ isAutoApprovalEnabled: isAutoApprovalEnabledMock }),
);
vi.mock("@/lib/cloud-logger", () => ({ cloudLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: prismaBusinessFindUniqueMock },
    paymentIntent: {
      findUnique: prismaPaymentIntentFindUniqueMock,
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    customer: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    courierCredential: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// Stubs for other tool packs loaded by buildVeloraMcpServer
vi.mock("@/infrastructure/shared/customer-mutations", () => ({
  createCustomerInTransaction: vi.fn(),
  updateCustomerInTransaction: vi.fn(),
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/payments-agent-helpers", () => ({
  resolveCustomerIdByName: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers", () => ({
  getMpTokenForBusiness: vi.fn(),
  createMpPreference: vi.fn(),
  MP_TOKEN_NOT_CONNECTED: "MP_TOKEN_NOT_CONNECTED",
  MP_TOKEN_EXPIRED: "MP_TOKEN_EXPIRED",
  MP_TOKEN_DECRYPT_ERROR: "MP_TOKEN_DECRYPT_ERROR",
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/mp-status-helpers", () => ({
  getMpPaymentStatusByPreference: vi.fn(),
}));

import { createTrackedPaymentLinkImpl } from "@/lib/mcp/_lib/velora-payment-link";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TextContent { type: "text"; text: string; }
interface StructuredContent { paymentLinkUrl: string | null; paymentIntentId: string; amountARS: number; currency: string; }
interface CallToolResult { isError?: boolean; content: TextContent[]; structuredContent?: StructuredContent; }
function asToolResult(raw: unknown): CallToolResult { return raw as CallToolResult; }

// ── Mock PaymentsBackend ───────────────────────────────────────────────────────

function makeMockBackend(
  createResult: CreateTrackedPaymentLinkResult = { paymentLinkUrl: "https://mp.link/123", paymentIntentId: "pi-test-001", amountARS: 5000 },
): PaymentsBackend {
  return {
    createPreference: vi.fn(),
    getMpPaymentStatus: vi.fn(),
    getPaymentStatus: vi.fn().mockResolvedValue({ domainError: "payment_intent_not_found", errorMessage: "Not found" }),
    listPendingOrders: vi.fn().mockResolvedValue([]),
    getCobroDetail: vi.fn().mockResolvedValue(null),
    getDeliveryReceipt: vi.fn().mockResolvedValue(null),
    createTrackedPaymentLink: vi.fn().mockResolvedValue(createResult),
    resolveWizardPrefill: vi.fn().mockResolvedValue({
      prefill: {
        description: "Test cobro",
        customerId: "cust-001",
        customerName: "Test Customer",
        items: [{ productId: "prod-001", quantity: 2, name: "Producto Test", unitPrice: 2500 }],
        totalARS: 5000,
      },
    }),
  };
}

// ── MCP transport helper with injected backend ─────────────────────────────────

async function buildConnectedClientWithBackend(
  businessId: string,
  backend: PaymentsBackend,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const { registerPaymentsTools } = await import("@/lib/mcp/payments-tools");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "test-payments-seam", version: "1.0.0" });
  registerPaymentsTools(server, businessId, backend);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, cleanup: async () => { await client.close(); await server.close(); } };
}

// ── Valid minimal args ────────────────────────────────────────────────────────

const VALID_ARGS = {
  customerId: "cust-001",
  items: [{ productId: "prod-001", quantity: 2 }],
  description: "Test cobro",
  idempotencyKey: "00000000-0000-0000-0000-000000000001",
};

const BUSINESS_ID = "biz-wizard-seam-001";

// ─────────────────────────────────────────────────────────────────────────────
// TOOL LAYER TESTS (via MCP transport with injected mock backend)
// ─────────────────────────────────────────────────────────────────────────────

describe("create_tracked_payment_link — tool layer (injected backend)", () => {
  it("missing customerId (empty string) → Zod gate or isError before reaching backend", async () => {
    // Zod schema has min(1) on customerId — the MCP SDK rejects this before our handler
    // runs (returns an MCP-level error). In both cases the backend must NOT be called.
    const backend = makeMockBackend();
    const { client, cleanup } = await buildConnectedClientWithBackend(BUSINESS_ID, backend);
    try {
      const raw = await client.callTool({
        name: "create_tracked_payment_link",
        arguments: { ...VALID_ARGS, customerId: "" },
      });
      const result = asToolResult(raw);
      // Whether it's a Zod rejection or our handler's errResp, it must be an error.
      expect(result.isError).toBe(true);
      // Backend must NOT be called — validation blocked it.
      expect(backend.createTrackedPaymentLink).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("missing idempotencyKey (empty string) → Zod gate or isError before reaching backend", async () => {
    // Zod schema has min(1) on idempotencyKey — MCP SDK rejects before our handler runs.
    const backend = makeMockBackend();
    const { client, cleanup } = await buildConnectedClientWithBackend(BUSINESS_ID, backend);
    try {
      const raw = await client.callTool({
        name: "create_tracked_payment_link",
        arguments: { ...VALID_ARGS, idempotencyKey: "" },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      expect(backend.createTrackedPaymentLink).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("backend success → structuredContent with paymentLinkUrl + paymentIntentId + amountARS", async () => {
    const backend = makeMockBackend({
      paymentLinkUrl: "https://mp.link/test-pi",
      paymentIntentId: "pi-success-001",
      amountARS: 12500,
    });
    const { client, cleanup } = await buildConnectedClientWithBackend(BUSINESS_ID, backend);
    try {
      const raw = await client.callTool({ name: "create_tracked_payment_link", arguments: VALID_ARGS });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe("Listo, generé el link de cobro.");
      expect(result.structuredContent?.paymentLinkUrl).toBe("https://mp.link/test-pi");
      expect(result.structuredContent?.paymentIntentId).toBe("pi-success-001");
      expect(result.structuredContent?.amountARS).toBe(12500);
      expect(result.structuredContent?.currency).toBe("ARS");
    } finally {
      await cleanup();
    }
  });

  it("domain error mp_not_connected → isError with correct code", async () => {
    const backend = makeMockBackend({ domainError: "mp_not_connected", errorMessage: "MercadoPago no conectado." });
    const { client, cleanup } = await buildConnectedClientWithBackend(BUSINESS_ID, backend);
    try {
      const raw = await client.callTool({ name: "create_tracked_payment_link", arguments: VALID_ARGS });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("mp_not_connected");
    } finally {
      await cleanup();
    }
  });

  it("domain error mp_token_expired → isError with correct code", async () => {
    const backend = makeMockBackend({ domainError: "mp_token_expired", errorMessage: "Token expirado." });
    const { client, cleanup } = await buildConnectedClientWithBackend(BUSINESS_ID, backend);
    try {
      const raw = await client.callTool({ name: "create_tracked_payment_link", arguments: VALID_ARGS });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("mp_token_expired");
    } finally {
      await cleanup();
    }
  });

  it("domain error mp_decrypt_error → isError with correct code", async () => {
    const backend = makeMockBackend({ domainError: "mp_decrypt_error", errorMessage: "Decrypt error." });
    const { client, cleanup } = await buildConnectedClientWithBackend(BUSINESS_ID, backend);
    try {
      const raw = await client.callTool({ name: "create_tracked_payment_link", arguments: VALID_ARGS });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("mp_decrypt_error");
    } finally {
      await cleanup();
    }
  });

  it("domain error payment_links_blocked → isError with correct code", async () => {
    const backend = makeMockBackend({ domainError: "payment_links_blocked", errorMessage: "Configurá el alias." });
    const { client, cleanup } = await buildConnectedClientWithBackend(BUSINESS_ID, backend);
    try {
      const raw = await client.callTool({ name: "create_tracked_payment_link", arguments: VALID_ARGS });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("payment_links_blocked");
    } finally {
      await cleanup();
    }
  });

  it("businessId comes from closure — backend receives tenantId from closure not args", async () => {
    const backend = makeMockBackend();
    const CLOSURE_BIZ = "biz-closure-isolation-001";
    const { client, cleanup } = await buildConnectedClientWithBackend(CLOSURE_BIZ, backend);
    try {
      await client.callTool({ name: "create_tracked_payment_link", arguments: VALID_ARGS });
      expect(backend.createTrackedPaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: CLOSURE_BIZ }),
      );
    } finally {
      await cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER-LEVEL TESTS (createTrackedPaymentLinkImpl with mocked dependencies)
// ─────────────────────────────────────────────────────────────────────────────

describe("createTrackedPaymentLinkImpl — adapter unit tests", () => {
  const BUID = "biz-adapter-unit-001";

  const BASE_INPUT = {
    tenantId: BUID,
    customerId: "cust-001",
    items: [{ productId: "prod-001", quantity: 2 }],
    description: "Venta test",
    idempotencyKey: "00000000-0000-0000-0000-000000000099",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    isAutoApprovalEnabledMock.mockResolvedValue(false);
    getMissingBusinessDataMock.mockReturnValue({ paymentLinks: { blocked: false, ownerPrompt: "" } });
    prismaBusinessFindUniqueMock.mockResolvedValue({
      postalCode: "5500", paymentProvider: "mercadopago", alias: null, whatsappPhone: "1111", cuit: "20111111119",
    });
    resolveSaleItemsForPreferenceMock.mockResolvedValue({ items: null });
  });

  it("NABAOS: amountARS in result is use-case grandTotal, not model-supplied", async () => {
    // The use-case computes grandTotal from DB prices — this is the NABAOS invariant.
    registerSaleWithPaymentLinkUseCaseMock.mockResolvedValue({
      outcome: "created",
      paymentIntentId: "pi-nabaos-001",
      saleId: "sale-nabaos-001",
      grandTotal: 7500, // ← DB-computed, not model-supplied
    });
    const mockAdapterInstance = { createCollection: vi.fn().mockResolvedValue({ checkoutUrl: "https://mp.link/nabaos", amountARS: 7500 }) };
    getPaymentProviderMock.mockResolvedValue(mockAdapterInstance);

    const result = await createTrackedPaymentLinkImpl(BASE_INPUT);

    expect("domainError" in result).toBe(false);
    if (!("domainError" in result)) {
      // amountARS must be the grandTotal from the use-case (7500), not any model input
      expect(result.amountARS).toBe(7500);
      expect(result.paymentIntentId).toBe("pi-nabaos-001");
    }
  });

  it("idempotencyKey dedups: replayed outcome → orphan-heal path (healed=false → reads existing link)", async () => {
    registerSaleWithPaymentLinkUseCaseMock.mockResolvedValue({
      outcome: "replayed",
      paymentIntentId: "pi-replay-001",
      saleId: "sale-replay-001",
    });
    // No orphan: providerRef already set → healed: false
    healOrphanedIntentMock.mockResolvedValue({ healed: false });
    prismaPaymentIntentFindUniqueMock.mockResolvedValue({
      checkoutUrl: "https://mp.link/existing",
      monto: { toNumber: () => 3000 },
    });

    const result = await createTrackedPaymentLinkImpl(BASE_INPUT);

    expect("domainError" in result).toBe(false);
    if (!("domainError" in result)) {
      expect(result.paymentLinkUrl).toBe("https://mp.link/existing");
      expect(result.amountARS).toBe(3000);
      expect(result.paymentIntentId).toBe("pi-replay-001");
    }
    // getPaymentProvider must NOT be called on healthy replay
    expect(getPaymentProviderMock).not.toHaveBeenCalled();
  });

  it("alias-missing (payment_links_blocked) → domainError discriminant", async () => {
    getMissingBusinessDataMock.mockReturnValue({
      paymentLinks: { blocked: true, ownerPrompt: "Configurá el alias antes de generar links." },
    });

    const result = await createTrackedPaymentLinkImpl(BASE_INPUT);

    expect(result).toMatchObject({
      domainError: "payment_links_blocked",
      errorMessage: "Configurá el alias antes de generar links.",
    });
    // Use-case must NOT be called — blocked before DB write
    expect(registerSaleWithPaymentLinkUseCaseMock).not.toHaveBeenCalled();
  });

  it("MP sentinel payment_provider_not_connected → domainError mp_not_connected", async () => {
    registerSaleWithPaymentLinkUseCaseMock.mockResolvedValue({
      outcome: "created",
      paymentIntentId: "pi-noconn-001",
      saleId: "sale-noconn-001",
      grandTotal: 1000,
    });
    const mockAdapterInstance = {
      createCollection: vi.fn().mockResolvedValue({ error: "payment_provider_not_connected" }),
    };
    getPaymentProviderMock.mockResolvedValue(mockAdapterInstance);

    const result = await createTrackedPaymentLinkImpl(BASE_INPUT);

    expect(result).toMatchObject({ domainError: "mp_not_connected" });
  });

  it("MP sentinel payment_provider_token_expired → domainError mp_token_expired", async () => {
    registerSaleWithPaymentLinkUseCaseMock.mockResolvedValue({
      outcome: "created",
      paymentIntentId: "pi-expired-001",
      saleId: "sale-expired-001",
      grandTotal: 1000,
    });
    const mockAdapterInstance = {
      createCollection: vi.fn().mockResolvedValue({ error: "payment_provider_token_expired" }),
    };
    getPaymentProviderMock.mockResolvedValue(mockAdapterInstance);

    const result = await createTrackedPaymentLinkImpl(BASE_INPUT);

    expect(result).toMatchObject({ domainError: "mp_token_expired" });
  });

  it("MP sentinel payment_token_decrypt_error → domainError mp_decrypt_error", async () => {
    registerSaleWithPaymentLinkUseCaseMock.mockResolvedValue({
      outcome: "created",
      paymentIntentId: "pi-decrypt-001",
      saleId: "sale-decrypt-001",
      grandTotal: 1000,
    });
    const mockAdapterInstance = {
      createCollection: vi.fn().mockResolvedValue({ error: "payment_token_decrypt_error" }),
    };
    getPaymentProviderMock.mockResolvedValue(mockAdapterInstance);

    const result = await createTrackedPaymentLinkImpl(BASE_INPUT);

    expect(result).toMatchObject({ domainError: "mp_decrypt_error" });
  });

  it("unexpected MP error → domainError mp_api_error", async () => {
    registerSaleWithPaymentLinkUseCaseMock.mockResolvedValue({
      outcome: "created",
      paymentIntentId: "pi-mpfail-001",
      saleId: "sale-mpfail-001",
      grandTotal: 1000,
    });
    const mockAdapterInstance = {
      createCollection: vi.fn().mockResolvedValue({ error: "some_unknown_mp_error" }),
    };
    getPaymentProviderMock.mockResolvedValue(mockAdapterInstance);

    const result = await createTrackedPaymentLinkImpl(BASE_INPUT);

    expect(result).toMatchObject({ domainError: "mp_api_error" });
  });

  it("tenant isolation: tenantId flows into the use-case as businessId", async () => {
    registerSaleWithPaymentLinkUseCaseMock.mockResolvedValue({
      outcome: "created",
      paymentIntentId: "pi-tenant-001",
      saleId: "sale-tenant-001",
      grandTotal: 500,
    });
    const mockAdapterInstance = {
      createCollection: vi.fn().mockResolvedValue({ checkoutUrl: "https://mp.link/t", amountARS: 500 }),
    };
    getPaymentProviderMock.mockResolvedValue(mockAdapterInstance);

    await createTrackedPaymentLinkImpl({ ...BASE_INPUT, tenantId: "biz-tenant-scoped-999" });

    expect(registerSaleWithPaymentLinkUseCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-tenant-scoped-999" }),
    );
    expect(getPaymentProviderMock).toHaveBeenCalledWith("biz-tenant-scoped-999");
  });
});
