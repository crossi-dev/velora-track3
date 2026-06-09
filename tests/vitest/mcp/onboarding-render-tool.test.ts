// tests/vitest/mcp/onboarding-render-tool.test.ts
//
// Unit tests for the open_onboarding render tool (onboarding-render.ts)
// and the buildIntegrationStatuses shared function (connection-tools.ts).
//
// Uses InMemoryTransport.createLinkedPair() — mirrors pending-orders-tool.test.ts.
//
// Mocked dependencies:
//   - @/lib/business-capabilities → loadBusinessCapabilities
//   - @/app/api/agents/fiscal/jsonrpc/_lib/fiscal-readiness → getFiscalReadiness
//
// Test groups:
//   1. Registration — open_onboarding appears / not appears depending on businessId
//   2. structuredContent — prefill.integrations array + prefill.baseUrl present
//   3. Status mapping — payments connected/not-connected reflects caps
//   4. WhatsApp tier — connected when whatsapp_business OR whatsapp_phone is set
//   5. Tenant scoping — businessId from closure, never from tool input
//   6. Error handling — buildIntegrationStatuses throws → isError response
//   7. buildIntegrationStatuses export — called by connection_status too (DRY)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { loadBusinessCapabilitiesMock, getFiscalReadinessMock } = vi.hoisted(() => ({
  loadBusinessCapabilitiesMock: vi.fn(),
  getFiscalReadinessMock: vi.fn(),
}));

vi.mock("@/lib/business-capabilities", () => ({
  loadBusinessCapabilities: loadBusinessCapabilitiesMock,
}));

vi.mock(
  "@/app/api/agents/fiscal/jsonrpc/_lib/fiscal-readiness",
  () => ({ getFiscalReadiness: getFiscalReadinessMock }),
);

// Prisma stubs — prevent real DB connection during server construction.
// tenantToolConfig.findUnique is called by resolveTenantBackendMap (server.ts).
// Other models are stubbed to satisfy tool registrations that access DB on init.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    paymentIntent: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
  },
}));

// ── Types ─────────────────────────────────────────────────────────────────────

interface IntegrationStatus {
  key: string;
  label: string;
  connected: boolean;
  missing: string[];
  guidance: string;
  connectUrl: string;
  connectMethod: "oauth" | "form";
}

interface Prefill {
  integrations: IntegrationStatus[];
  baseUrl: string;
}

interface TextContent { type: "text"; text: string }
interface CallToolResult { isError?: boolean; content: TextContent[]; structuredContent?: unknown }

function asToolResult(raw: unknown): CallToolResult {
  return raw as CallToolResult;
}

// ── Default capability fixtures ───────────────────────────────────────────────

function defaultCaps(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    mercadopago: false,
    alias_cbu: false,
    andreani: false,
    whatsapp_business: false,
    whatsapp_phone: false,
    twilio_sms: false,
    resend: false,
    pedidosya: false,
    ...overrides,
  };
}

function defaultFiscal(overrides: Partial<{ ready: boolean; missing: string[]; guidance: string }> = {}) {
  return {
    ready: false,
    missing: ["ARCA certificate"],
    guidance: "Conectá ARCA",
    ...overrides,
  };
}

const BUSINESS_ID = "biz-onboarding-001";

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

describe("open_onboarding tool — registration", () => {
  beforeEach(() => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps());
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
  });

  it("includes open_onboarding when businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("open_onboarding");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include open_onboarding when no businessId", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("open_onboarding");
    } finally {
      await cleanup();
    }
  });
});

// ── structuredContent prefill ─────────────────────────────────────────────────

describe("open_onboarding — structuredContent prefill", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns structuredContent.prefill.integrations array with 7 items", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps());
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { prefill: Prefill };
      expect(sc.prefill.integrations).toHaveLength(7);
    } finally {
      await cleanup();
    }
  });

  it("returns structuredContent.prefill.baseUrl as a non-empty string", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps());
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: Prefill };
      expect(typeof sc.prefill.baseUrl).toBe("string");
      expect(sc.prefill.baseUrl.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("integration keys include fiscal, payments, shipping, whatsapp, sms, email, pedidosya", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps());
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: Prefill };
      const keys = sc.prefill.integrations.map((i) => i.key);
      expect(keys).toEqual(["fiscal", "payments", "shipping", "whatsapp", "sms", "email", "pedidosya"]);
    } finally {
      await cleanup();
    }
  });
});

// ── Status mapping ────────────────────────────────────────────────────────────

describe("open_onboarding — payments status mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("payments connected=true when mercadopago=true", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps({ mercadopago: true }));
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: Prefill };
      const payments = sc.prefill.integrations.find((i) => i.key === "payments")!;
      expect(payments.connected).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("payments connected=true when alias_cbu=true (even without mercadopago)", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps({ alias_cbu: true }));
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: Prefill };
      const payments = sc.prefill.integrations.find((i) => i.key === "payments")!;
      expect(payments.connected).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("payments connected=false when neither mercadopago nor alias_cbu", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps());
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: Prefill };
      const payments = sc.prefill.integrations.find((i) => i.key === "payments")!;
      expect(payments.connected).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

// ── WhatsApp tier ─────────────────────────────────────────────────────────────

describe("open_onboarding — whatsapp tier logic", () => {
  beforeEach(() => vi.clearAllMocks());

  it("whatsapp connected=true when whatsapp_business=true", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps({ whatsapp_business: true }));
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: Prefill };
      const wa = sc.prefill.integrations.find((i) => i.key === "whatsapp")!;
      expect(wa.connected).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("whatsapp connected=true when only whatsapp_phone=true", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps({ whatsapp_phone: true }));
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: Prefill };
      const wa = sc.prefill.integrations.find((i) => i.key === "whatsapp")!;
      expect(wa.connected).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("whatsapp connected=false when neither whatsapp_business nor whatsapp_phone", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps());
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: Prefill };
      const wa = sc.prefill.integrations.find((i) => i.key === "whatsapp")!;
      expect(wa.connected).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

// ── Tenant scoping ────────────────────────────────────────────────────────────

describe("open_onboarding — tenant scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls loadBusinessCapabilities with businessId from closure", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps());
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({ name: "open_onboarding", arguments: {} });
      expect(loadBusinessCapabilitiesMock).toHaveBeenCalledWith(BUSINESS_ID);
    } finally {
      await cleanup();
    }
  });

  it("ignores any businessId passed in tool arguments — closure wins", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps());
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const OTHER_BIZ = "biz-rogue-other";
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({ name: "open_onboarding", arguments: { businessId: OTHER_BIZ } });
      expect(loadBusinessCapabilitiesMock).toHaveBeenCalledWith(BUSINESS_ID);
      expect(loadBusinessCapabilitiesMock).not.toHaveBeenCalledWith(OTHER_BIZ);
    } finally {
      await cleanup();
    }
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("open_onboarding — error handling", () => {
  it("returns isError: true when buildIntegrationStatuses throws", async () => {
    loadBusinessCapabilitiesMock.mockRejectedValue(new Error("DB timeout"));
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("ONBOARDING_STATUS_ERROR");
    } finally {
      await cleanup();
    }
  });
});

// ── DRY: buildIntegrationStatuses is shared with connection_status ────────────

describe("buildIntegrationStatuses — shared with connection_status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("connection_status and open_onboarding both call loadBusinessCapabilities once each", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps({ andreani: true }));
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal({ ready: true, missing: [], guidance: "" }));
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({ name: "connection_status", arguments: {} });
      await client.callTool({ name: "open_onboarding", arguments: {} });
      // Each tool call invokes the function once
      expect(loadBusinessCapabilitiesMock).toHaveBeenCalledTimes(2);
      expect(loadBusinessCapabilitiesMock).toHaveBeenNthCalledWith(1, BUSINESS_ID);
      expect(loadBusinessCapabilitiesMock).toHaveBeenNthCalledWith(2, BUSINESS_ID);
    } finally {
      await cleanup();
    }
  });

  it("shipping connected=true when andreani=true", async () => {
    loadBusinessCapabilitiesMock.mockResolvedValue(defaultCaps({ andreani: true }));
    getFiscalReadinessMock.mockResolvedValue(defaultFiscal());
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({ name: "open_onboarding", arguments: {} });
      const result = asToolResult(raw);
      const sc = result.structuredContent as { prefill: Prefill };
      const shipping = sc.prefill.integrations.find((i) => i.key === "shipping")!;
      expect(shipping.connected).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
