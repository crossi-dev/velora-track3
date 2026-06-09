// tests/vitest/mcp/payment-status-mcp.test.ts
//
// Unit tests for the get_payment_intent_status MCP tool (added in Batch 2).
// Uses InMemoryTransport.createLinkedPair() — mirrors payments-tools.test.ts style.
//
// Mocked dependencies:
//   - getPaymentProvider       — returns a mock adapter with getStatus()
//   - resolveCustomerIdByName  — controls customer name → id lookup
//   - prisma.paymentIntent      — controls most-recent-intent lookup + ownership pre-check
//
// No real DB, no real payment provider calls.
//
// Tests cover:
//   - get_payment_intent_status is registered when businessId present
//   - happy path by paymentIntentId → returns status + providerRef
//   - happy path by customerName → resolves customer + returns latest intent status
//   - missing both paymentIntentId and customerName → isError: true (missing_lookup_key)
//   - customer name not found → isError: true (customer_not_found)
//   - no payment intent for customer → isError: true (no_payment_intent_found)
//   - provider returns error status → isError: true (status_lookup_failed)
//   - businessId comes from closure
//   - TENANT ISOLATION: paymentIntentId not owned by business → isError (pre-check blocks adapter call)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  getPaymentProviderMock,
  resolveCustomerIdByNameMock,
  paymentIntentFindFirstMock,
  mockAdapter,
  getMpTokenForBusinessMock,
  createMpPreferenceMock,
  getMpPaymentStatusByPreferenceMock,
} = vi.hoisted(() => {
  const adapter = { getStatus: vi.fn(), createCollection: vi.fn() };
  return {
    getPaymentProviderMock: vi.fn().mockResolvedValue(adapter),
    resolveCustomerIdByNameMock: vi.fn(),
    paymentIntentFindFirstMock: vi.fn(),
    mockAdapter: adapter,
    getMpTokenForBusinessMock: vi.fn(),
    createMpPreferenceMock: vi.fn(),
    getMpPaymentStatusByPreferenceMock: vi.fn(),
  };
});

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/payment-provider",
  () => ({ getPaymentProvider: getPaymentProviderMock }),
);

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/payments-agent-helpers",
  () => ({ resolveCustomerIdByName: resolveCustomerIdByNameMock }),
);

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers",
  async (importOriginal) => {
    const original = await importOriginal<
      typeof import("@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers")
    >();
    return {
      ...original,
      getMpTokenForBusiness: getMpTokenForBusinessMock,
      createMpPreference: createMpPreferenceMock,
    };
  },
);

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/mp-status-helpers",
  () => ({ getMpPaymentStatusByPreference: getMpPaymentStatusByPreferenceMock }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentIntent: { findFirst: paymentIntentFindFirstMock },
    // Stubs for other tool packs loaded by buildVeloraMcpServer when businessId present
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista", courierPreference: null }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    courierCredential: { findMany: vi.fn().mockResolvedValue([]) },
    customer: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
    // Stub for resolveTenantBackendMap — null = all env / "velora" defaults
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

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

describe("get_payment_intent_status — registration", () => {
  it("is included when businessId is present", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-gps-001");
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("get_payment_intent_status");
    } finally {
      await cleanup();
    }
  });

  it("is NOT registered when no businessId", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("get_payment_intent_status");
    } finally {
      await cleanup();
    }
  });
});

// ── get_payment_intent_status ────────────────────────────────────────────────────────

describe("get_payment_intent_status tool", () => {
  const BUSINESS_ID = "biz-gps-tests-001";

  beforeEach(() => {
    vi.clearAllMocks();
    getPaymentProviderMock.mockResolvedValue(mockAdapter);
  });

  it("returns status by paymentIntentId (happy path)", async () => {
    // First findFirst call: ownership pre-check returns the owned intent.
    paymentIntentFindFirstMock.mockResolvedValue({ id: "pi-001" });
    mockAdapter.getStatus.mockResolvedValue({
      paymentIntentId: "pi-001",
      status: "approved",
      providerRef: "mp-ref-123",
      currency: "ARS",
    });

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_payment_intent_status",
        arguments: { paymentIntentId: "pi-001" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        paymentIntentId: string;
        status: string;
        providerRef: string | null;
        currency: string;
      };
      expect(parsed.paymentIntentId).toBe("pi-001");
      expect(parsed.status).toBe("approved");
      expect(parsed.providerRef).toBe("mp-ref-123");
      expect(parsed.currency).toBe("ARS");
    } finally {
      await cleanup();
    }
  });

  it("resolves by customerName → returns latest intent status", async () => {
    resolveCustomerIdByNameMock.mockResolvedValue("cust-001");
    paymentIntentFindFirstMock.mockResolvedValue({ id: "pi-by-customer-001" });
    mockAdapter.getStatus.mockResolvedValue({
      paymentIntentId: "pi-by-customer-001",
      status: "pending",
      providerRef: null,
      currency: "ARS",
    });

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_payment_intent_status",
        arguments: { customerName: "María García" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        paymentIntentId: string;
        status: string;
      };
      expect(parsed.paymentIntentId).toBe("pi-by-customer-001");
      expect(parsed.status).toBe("pending");
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true (missing_lookup_key) when neither arg provided", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_payment_intent_status",
        arguments: {},
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("missing_lookup_key");
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true (customer_not_found) when name lookup fails", async () => {
    resolveCustomerIdByNameMock.mockResolvedValue(null);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_payment_intent_status",
        arguments: { customerName: "Cliente Fantasma" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("customer_not_found");
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true (no_payment_intent_found) when customer has no intents", async () => {
    resolveCustomerIdByNameMock.mockResolvedValue("cust-no-intents");
    paymentIntentFindFirstMock.mockResolvedValue(null);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_payment_intent_status",
        arguments: { customerName: "Cliente Sin Cobros" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("no_payment_intent_found");
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true (status_lookup_failed) when provider returns error status", async () => {
    // Ownership pre-check passes — intent belongs to this business.
    paymentIntentFindFirstMock.mockResolvedValue({ id: "pi-err-001" });
    mockAdapter.getStatus.mockResolvedValue({
      paymentIntentId: "pi-err-001",
      status: "error",
      message: "Provider unavailable",
      currency: "ARS",
    });

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_payment_intent_status",
        arguments: { paymentIntentId: "pi-err-001" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string; message: string };
      expect(parsed.error).toBe("status_lookup_failed");
      expect(parsed.message).toContain("Provider unavailable");
    } finally {
      await cleanup();
    }
  });

  it("passes businessId from closure to getPaymentProvider", async () => {
    // Ownership pre-check passes.
    paymentIntentFindFirstMock.mockResolvedValue({ id: "pi-closure-001" });
    mockAdapter.getStatus.mockResolvedValue({
      paymentIntentId: "pi-closure-001",
      status: "approved",
      currency: "ARS",
    });

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "get_payment_intent_status",
        arguments: { paymentIntentId: "pi-closure-001" },
      });
      expect(getPaymentProviderMock).toHaveBeenCalledWith(BUSINESS_ID);
    } finally {
      await cleanup();
    }
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  it("TENANT ISOLATION: paymentIntentId not owned by business → isError, adapter never called", async () => {
    // The ownership pre-check returns null — intent belongs to a different tenant.
    // The old code had no pre-check — it would dispatch to the adapter with a foreign ID.
    // This test would FAIL on the old code (it would reach getPaymentProvider).
    paymentIntentFindFirstMock.mockResolvedValue(null);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "get_payment_intent_status",
        arguments: { paymentIntentId: "pi-foreign-tenant-999" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      expect(parsed.error).toBe("payment_intent_not_found");
      // Adapter must NOT have been called — the pre-check blocked it.
      expect(mockAdapter.getStatus).not.toHaveBeenCalled();
      expect(getPaymentProviderMock).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});
