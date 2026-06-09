// tests/vitest/mcp/onboarding-tools.test.ts
//
// Unit tests for the 5 conversational onboarding MCP tools.
// Uses InMemoryTransport.createLinkedPair() — mirrors customer-tools.test.ts style.
//
// Coverage:
//   Registration:
//     - tools registered when businessId present
//     - tools NOT registered when no businessId
//
//   connect_mercadopago:
//     PRIMARY (BYOA OAuth-redirect — MCP 2025-11-25 standard):
//     - no accessToken → returns { ok, action: 'authorize', authorizationUrl, instructions }
//     - no accessToken + MP not configured → isError: true, MP_NOT_CONFIGURED
//     - createOAuthState throws → isError: true, UPSERT_FAILED
//     FALLBACK (optional APP_USR- token):
//     - accessToken supplied → returns { ok: true, mpUserId } (token path)
//     - invalid token (MP returns 401) → isError: true, INVALID_TOKEN
//     - MP unreachable (network throw) → isError: true, MP_UNREACHABLE
//     - businessId comes from closure (extra arg in input ignored)
//
//   connect_pedidosya:
//     PRIMARY (BYOA secure-form link):
//     - no apiToken → returns { ok, action: 'connect_form', connectUrl, instructions }
//     - connectUrl points to the Servicios deep-link (never a raw token)
//     FALLBACK (optional apiToken):
//     - apiToken supplied → returns { ok: true }
//     - invalid token → isError: true, INVALID_TOKEN
//     - businessId comes from closure
//
//   connect_whatsapp:
//     PRIMARY (BYOA Meta Embedded Signup link):
//     - no phone → returns { ok, action: 'authorize', connectUrl, instructions }
//     - connectUrl points to the Servicios deep-link (never a credential)
//     OPTIONAL phone pre-step:
//     - phone supplied → phone captured AND returns connectUrl + instructions
//     - invalid phone → isError: true, INVALID_PHONE
//     - businessId comes from closure
//
//   connect_tiendanube:
//     PRIMARY (BYOA OAuth-redirect — same model as connect_mercadopago):
//     - no args → returns { ok, action: 'authorize', authorizationUrl, instructions }
//     - authorizationUrl contains tiendanube.com + state token
//     - TN not configured → isError: true, TN_NOT_CONFIGURED
//     - createOAuthState throws → isError: true, UPSERT_FAILED
//     - businessId comes from closure (no token ever in response)
//
//   upload_catalog:
//     - success path (3 items) → returns { created: 3, skipped: [] }
//     - cap at 50 (enforced by Zod)
//     - skip items with empty name or non-positive price
//     - businessId comes from closure

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  connectMercadoPagoMock,
  getMpConfigMock,
  createOAuthStateMock,
  buildMpAuthorizationUrlMock,
  connectPedidosYaMock,
  createOnboardingProductMock,
  prismaBusinessUpdateMock,
  recordCriticalWriteEventMock,
  getTiendanubeConfigMock,
  buildTiendanubeAuthorizationUrlMock,
} = vi.hoisted(() => ({
  connectMercadoPagoMock: vi.fn(),
  getMpConfigMock: vi.fn(),
  createOAuthStateMock: vi.fn(),
  buildMpAuthorizationUrlMock: vi.fn(),
  connectPedidosYaMock: vi.fn(),
  createOnboardingProductMock: vi.fn(),
  prismaBusinessUpdateMock: vi.fn(),
  recordCriticalWriteEventMock: vi.fn().mockResolvedValue(true),
  getTiendanubeConfigMock: vi.fn(),
  buildTiendanubeAuthorizationUrlMock: vi.fn(),
}));

vi.mock(
  "@/app/api/integrations/mp/connect-token/_lib/mp-connect-core",
  () => ({ connectMercadoPago: connectMercadoPagoMock }),
);

vi.mock(
  "@/app/api/integrations/mp/_lib/config",
  () => ({
    getMpConfig: getMpConfigMock,
    buildMpAuthorizationUrl: buildMpAuthorizationUrlMock,
  }),
);

vi.mock(
  "@/app/api/integrations/mp/_lib/oauth-state",
  () => ({ createOAuthState: createOAuthStateMock }),
);

vi.mock(
  "@/app/api/integrations/comunicaciones/connect/_lib/pedidosya-connect-core",
  () => ({ connectPedidosYa: connectPedidosYaMock }),
);

vi.mock(
  "@/app/api/integrations/tiendanube/_lib/config",
  () => ({
    getTiendanubeConfig: getTiendanubeConfigMock,
    buildTiendanubeAuthorizationUrl: buildTiendanubeAuthorizationUrlMock,
  }),
);

vi.mock(
  "@/app/api/supervisor/_lib/onboarding-product-actions",
  () => ({ createOnboardingProduct: createOnboardingProductMock }),
);

vi.mock("@/infrastructure/shared/critical-write-audit", () => ({
  recordCriticalWriteEvent: recordCriticalWriteEventMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { update: prismaBusinessUpdateMock },
    // Stubs to prevent failures from fiscal/payments/ventas/logistica tools
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    courierCredential: { findMany: vi.fn().mockResolvedValue([]) },
    mpConnection: { findUnique: vi.fn().mockResolvedValue(null) },
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// ── Types ─────────────────────────────────────────────────────────────────────

interface TextContent { type: "text"; text: string; }
interface CallToolResult { isError?: boolean; content: TextContent[]; }
function asToolResult(raw: unknown): CallToolResult { return raw as CallToolResult; }

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

describe("onboarding tools — registration", () => {
  it("registers all 5 onboarding tools when businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("connect_mercadopago");
      expect(names).toContain("connect_pedidosya");
      expect(names).toContain("connect_whatsapp");
      expect(names).toContain("connect_tiendanube");
      expect(names).toContain("upload_catalog");
    } finally {
      await cleanup();
    }
  });

  it("does NOT register onboarding tools when no businessId", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("connect_mercadopago");
      expect(names).not.toContain("connect_pedidosya");
      expect(names).not.toContain("connect_whatsapp");
      expect(names).not.toContain("connect_tiendanube");
      expect(names).not.toContain("upload_catalog");
    } finally {
      await cleanup();
    }
  });
});

// ── connect_mercadopago ───────────────────────────────────────────────────────

describe("connect_mercadopago", () => {
  beforeEach(() => {
    connectMercadoPagoMock.mockReset();
    getMpConfigMock.mockReset();
    createOAuthStateMock.mockReset();
    buildMpAuthorizationUrlMock.mockReset();
  });

  // ── PRIMARY path: BYOA OAuth-redirect (no accessToken) ──────────────────────

  it("primary: no accessToken → returns authorizationUrl and instructions", async () => {
    getMpConfigMock.mockReturnValue({ isConfigured: true, clientId: "mp-client", redirectUri: "https://somosvelora.com/api/integrations/mp/callback", mockMode: false });
    createOAuthStateMock.mockResolvedValue("csrf-state-token-abc");
    buildMpAuthorizationUrlMock.mockReturnValue("https://auth.mercadopago.com.ar/authorization?client_id=mp-client&state=csrf-state-token-abc");
    const { client, cleanup } = await buildConnectedClient("biz-mp-oauth-01");
    try {
      // No accessToken argument → primary OAuth path
      const raw = await client.callTool({ name: "connect_mercadopago", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.action).toBe("authorize");
      expect(body.authorizationUrl).toContain("auth.mercadopago.com.ar");
      expect(typeof body.instructions).toBe("string");
      expect(body.instructions.length).toBeGreaterThan(0);
      // No token in the response
      expect(body.accessToken).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("primary: createOAuthState uses closure businessId", async () => {
    getMpConfigMock.mockReturnValue({ isConfigured: true, clientId: "mp-client", redirectUri: "https://somosvelora.com/api/integrations/mp/callback", mockMode: false });
    createOAuthStateMock.mockResolvedValue("state-xyz");
    buildMpAuthorizationUrlMock.mockReturnValue("https://auth.mercadopago.com.ar/authorization?state=state-xyz");
    const { client, cleanup } = await buildConnectedClient("closure-mp-oauth");
    try {
      await client.callTool({ name: "connect_mercadopago", arguments: {} });
      expect(createOAuthStateMock).toHaveBeenCalledWith("closure-mp-oauth");
    } finally {
      await cleanup();
    }
  });

  it("primary: MP not configured → isError with MP_NOT_CONFIGURED", async () => {
    getMpConfigMock.mockReturnValue({ isConfigured: false, clientId: "", redirectUri: "", mockMode: false });
    const { client, cleanup } = await buildConnectedClient("biz-mp-oauth-02");
    try {
      const raw = await client.callTool({ name: "connect_mercadopago", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("MP_NOT_CONFIGURED");
    } finally {
      await cleanup();
    }
  });

  it("primary: createOAuthState throws → isError with UPSERT_FAILED", async () => {
    getMpConfigMock.mockReturnValue({ isConfigured: true, clientId: "mp-client", redirectUri: "https://somosvelora.com/api/integrations/mp/callback", mockMode: false });
    createOAuthStateMock.mockRejectedValue(new Error("DB connection error"));
    const { client, cleanup } = await buildConnectedClient("biz-mp-oauth-03");
    try {
      const raw = await client.callTool({ name: "connect_mercadopago", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("UPSERT_FAILED");
    } finally {
      await cleanup();
    }
  });

  // ── FALLBACK path: optional APP_USR- token supplied ─────────────────────────

  it("fallback: accessToken supplied → returns { ok: true, mpUserId }", async () => {
    connectMercadoPagoMock.mockResolvedValue({ ok: true, mpUserId: "123456789" });
    const { client, cleanup } = await buildConnectedClient("biz-mp-01");
    try {
      const raw = await client.callTool({ name: "connect_mercadopago", arguments: { accessToken: "APP_USR-test-token-value" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.mpUserId).toBe("123456789");
      // OAuth helpers NOT called in token-fallback path
      expect(getMpConfigMock).not.toHaveBeenCalled();
      expect(createOAuthStateMock).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("fallback: invalid token → isError with INVALID_TOKEN", async () => {
    connectMercadoPagoMock.mockResolvedValue({ ok: false, code: "INVALID_TOKEN", message: "Token inválido." });
    const { client, cleanup } = await buildConnectedClient("biz-mp-02");
    try {
      const raw = await client.callTool({ name: "connect_mercadopago", arguments: { accessToken: "APP_USR-bad-token-xx" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("INVALID_TOKEN");
    } finally {
      await cleanup();
    }
  });

  it("fallback: MP unreachable → isError with MP_UNREACHABLE", async () => {
    connectMercadoPagoMock.mockResolvedValue({ ok: false, code: "MP_UNREACHABLE", message: "Network error." });
    const { client, cleanup } = await buildConnectedClient("biz-mp-03");
    try {
      const raw = await client.callTool({ name: "connect_mercadopago", arguments: { accessToken: "APP_USR-valid-token-xx" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("MP_UNREACHABLE");
    } finally {
      await cleanup();
    }
  });

  it("fallback: businessId from closure — extra arg in input ignored", async () => {
    connectMercadoPagoMock.mockResolvedValue({ ok: true, mpUserId: "999" });
    const { client, cleanup } = await buildConnectedClient("closure-biz-id");
    try {
      await client.callTool({ name: "connect_mercadopago", arguments: { accessToken: "APP_USR-valid-token-xx" } });
      // The core was called with the closure businessId, not any tool arg
      expect(connectMercadoPagoMock).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: "closure-biz-id" }),
      );
    } finally {
      await cleanup();
    }
  });
});

// ── connect_pedidosya ─────────────────────────────────────────────────────────

describe("connect_pedidosya", () => {
  beforeEach(() => { connectPedidosYaMock.mockReset(); });

  // ── PRIMARY path: BYOA secure-form link (no apiToken) ───────────────────────

  it("primary: no apiToken → returns connect_form link and instructions", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-py-primary-01");
    try {
      const raw = await client.callTool({ name: "connect_pedidosya", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.action).toBe("connect_form");
      expect(body.connectUrl).toContain("tab=servicios");
      expect(body.connectUrl).toContain("provider=pedidosya");
      expect(typeof body.instructions).toBe("string");
      expect(body.instructions.length).toBeGreaterThan(0);
      // No token in the response
      expect(body.apiToken).toBeUndefined();
      // Core NOT called in primary path
      expect(connectPedidosYaMock).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("primary: connectUrl does not contain any credential", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-py-primary-02");
    try {
      const raw = await client.callTool({ name: "connect_pedidosya", arguments: {} });
      const result = asToolResult(raw);
      const body = JSON.parse(result.content[0].text);
      // The URL must be a dashboard deep-link, not an endpoint that accepts a token
      expect(body.connectUrl).toMatch(/^https?:\/\/.+\/dashboard\?/);
    } finally {
      await cleanup();
    }
  });

  // ── FALLBACK path: optional apiToken supplied ────────────────────────────────

  it("fallback: apiToken supplied → returns { ok: true }", async () => {
    connectPedidosYaMock.mockResolvedValue({ ok: true });
    const { client, cleanup } = await buildConnectedClient("biz-py-01");
    try {
      const raw = await client.callTool({ name: "connect_pedidosya", arguments: { apiToken: "py-token-abc123" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("fallback: invalid token → isError with INVALID_TOKEN", async () => {
    connectPedidosYaMock.mockResolvedValue({ ok: false, code: "INVALID_TOKEN", message: "Token vacío." });
    const { client, cleanup } = await buildConnectedClient("biz-py-02");
    try {
      const raw = await client.callTool({ name: "connect_pedidosya", arguments: { apiToken: "tok" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("INVALID_TOKEN");
    } finally {
      await cleanup();
    }
  });

  it("fallback: tenant-scoped — businessId from closure", async () => {
    connectPedidosYaMock.mockResolvedValue({ ok: true });
    const { client, cleanup } = await buildConnectedClient("closure-py-biz");
    try {
      await client.callTool({ name: "connect_pedidosya", arguments: { apiToken: "py-real-token" } });
      expect(connectPedidosYaMock).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: "closure-py-biz" }),
      );
    } finally {
      await cleanup();
    }
  });
});

// ── connect_whatsapp ──────────────────────────────────────────────────────────

describe("connect_whatsapp", () => {
  beforeEach(() => { prismaBusinessUpdateMock.mockReset(); recordCriticalWriteEventMock.mockReset(); });

  // ── PRIMARY path: BYOA Meta Embedded Signup link (no phone) ─────────────────

  it("primary: no phone → returns authorize link and instructions", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-wa-primary-01");
    try {
      const raw = await client.callTool({ name: "connect_whatsapp", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.action).toBe("authorize");
      expect(body.connectUrl).toContain("tab=servicios");
      expect(body.connectUrl).toContain("provider=whatsapp");
      expect(typeof body.instructions).toBe("string");
      expect(body.instructions.length).toBeGreaterThan(0);
      // No credential in the response
      expect(body.phone).toBeUndefined();
      // Prisma NOT called in primary path (no phone capture)
      expect(prismaBusinessUpdateMock).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("primary: connectUrl does not contain any credential", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-wa-primary-02");
    try {
      const raw = await client.callTool({ name: "connect_whatsapp", arguments: {} });
      const result = asToolResult(raw);
      const body = JSON.parse(result.content[0].text);
      // Must be the dashboard Servicios deep-link, not a credential-accepting endpoint
      expect(body.connectUrl).toMatch(/^https?:\/\/.+\/dashboard\?/);
    } finally {
      await cleanup();
    }
  });

  // ── OPTIONAL phone pre-step ──────────────────────────────────────────────────

  it("phone pre-step: valid E.164 → captures phone AND returns authorize link", async () => {
    prismaBusinessUpdateMock.mockResolvedValue({});
    recordCriticalWriteEventMock.mockResolvedValue(true);
    const { client, cleanup } = await buildConnectedClient("biz-wa-01");
    try {
      const raw = await client.callTool({ name: "connect_whatsapp", arguments: { phone: "+5491144445555" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.action).toBe("authorize");
      expect(body.phone).toBe("+5491144445555");
      expect(body.connectUrl).toContain("provider=whatsapp");
      expect(typeof body.instructions).toBe("string");
    } finally {
      await cleanup();
    }
  });

  it("phone pre-step: invalid phone → isError with INVALID_PHONE", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-wa-02");
    try {
      // No + prefix — not valid E.164
      const raw = await client.callTool({ name: "connect_whatsapp", arguments: { phone: "5491144445555" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("INVALID_PHONE");
    } finally {
      await cleanup();
    }
  });

  it("phone pre-step: tenant-scoped — prisma.business.update uses closure businessId", async () => {
    prismaBusinessUpdateMock.mockResolvedValue({});
    recordCriticalWriteEventMock.mockResolvedValue(true);
    const { client, cleanup } = await buildConnectedClient("closure-wa-biz");
    try {
      await client.callTool({ name: "connect_whatsapp", arguments: { phone: "+5491100000000" } });
      expect(prismaBusinessUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "closure-wa-biz" } }),
      );
    } finally {
      await cleanup();
    }
  });
});

// ── connect_tiendanube ────────────────────────────────────────────────────────

describe("connect_tiendanube", () => {
  beforeEach(() => {
    getTiendanubeConfigMock.mockReset();
    buildTiendanubeAuthorizationUrlMock.mockReset();
    createOAuthStateMock.mockReset();
  });

  it("primary: no args → returns authorizationUrl and instructions", async () => {
    getTiendanubeConfigMock.mockReturnValue({ isConfigured: true, clientId: "tn-app-id" });
    createOAuthStateMock.mockResolvedValue("tn-csrf-state-abc");
    buildTiendanubeAuthorizationUrlMock.mockReturnValue(
      "https://www.tiendanube.com/apps/tn-app-id/authorize?state=tn-csrf-state-abc",
    );
    const { client, cleanup } = await buildConnectedClient("biz-tn-01");
    try {
      const raw = await client.callTool({ name: "connect_tiendanube", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.action).toBe("authorize");
      expect(body.authorizationUrl).toContain("tiendanube.com");
      expect(body.authorizationUrl).toContain("tn-csrf-state-abc");
      expect(typeof body.instructions).toBe("string");
      expect(body.instructions.length).toBeGreaterThan(0);
      // No token in the response
      expect(body.accessToken).toBeUndefined();
      expect(body.storeId).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("primary: createOAuthState uses closure businessId", async () => {
    getTiendanubeConfigMock.mockReturnValue({ isConfigured: true, clientId: "tn-app-id" });
    createOAuthStateMock.mockResolvedValue("state-xyz");
    buildTiendanubeAuthorizationUrlMock.mockReturnValue(
      "https://www.tiendanube.com/apps/tn-app-id/authorize?state=state-xyz",
    );
    const { client, cleanup } = await buildConnectedClient("closure-tn-biz");
    try {
      await client.callTool({ name: "connect_tiendanube", arguments: {} });
      expect(createOAuthStateMock).toHaveBeenCalledWith("closure-tn-biz");
    } finally {
      await cleanup();
    }
  });

  it("primary: TN not configured → isError with TN_NOT_CONFIGURED", async () => {
    getTiendanubeConfigMock.mockReturnValue({ isConfigured: false, clientId: "" });
    const { client, cleanup } = await buildConnectedClient("biz-tn-02");
    try {
      const raw = await client.callTool({ name: "connect_tiendanube", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("TN_NOT_CONFIGURED");
    } finally {
      await cleanup();
    }
  });

  it("primary: createOAuthState throws → isError with UPSERT_FAILED", async () => {
    getTiendanubeConfigMock.mockReturnValue({ isConfigured: true, clientId: "tn-app-id" });
    createOAuthStateMock.mockRejectedValue(new Error("DB connection error"));
    const { client, cleanup } = await buildConnectedClient("biz-tn-03");
    try {
      const raw = await client.callTool({ name: "connect_tiendanube", arguments: {} });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("UPSERT_FAILED");
    } finally {
      await cleanup();
    }
  });
});

// ── upload_catalog ────────────────────────────────────────────────────────────

describe("upload_catalog", () => {
  beforeEach(() => { createOnboardingProductMock.mockReset(); });

  it("success: creates all valid items and returns created count", async () => {
    createOnboardingProductMock.mockResolvedValue({ productId: "p-1", name: "Widget" });
    const { client, cleanup } = await buildConnectedClient("biz-cat-01");
    try {
      const raw = await client.callTool({
        name: "upload_catalog",
        arguments: {
          products: [
            { name: "Widget A", price: 1000 },
            { name: "Widget B", price: 500 },
            { name: "Widget C", price: 250 },
          ],
        },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.created).toBe(3);
      expect(body.skipped).toHaveLength(0);
      expect(createOnboardingProductMock).toHaveBeenCalledTimes(3);
    } finally {
      await cleanup();
    }
  });

  it("skips items with empty name and reports them", async () => {
    createOnboardingProductMock.mockResolvedValue({ productId: "p-2", name: "Valid" });
    const { client, cleanup } = await buildConnectedClient("biz-cat-02");
    try {
      const raw = await client.callTool({
        name: "upload_catalog",
        arguments: {
          products: [
            { name: "Valid Product", price: 100 },
            { name: "  ", price: 200 },       // empty after trim
            { name: "Another", price: 300 },
          ],
        },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.created).toBe(2);
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0].reason).toBe("empty name");
    } finally {
      await cleanup();
    }
  });

  it("skips items with non-positive price and reports them", async () => {
    createOnboardingProductMock.mockResolvedValue({ productId: "p-3", name: "OK" });
    const { client, cleanup } = await buildConnectedClient("biz-cat-03");
    try {
      const raw = await client.callTool({
        name: "upload_catalog",
        arguments: {
          products: [
            { name: "Good", price: 100 },
            { name: "Zero", price: 0 },
            { name: "Negative", price: -50 },
          ],
        },
      });
      const result = asToolResult(raw);
      const body = JSON.parse(result.content[0].text);
      expect(body.created).toBe(1);
      expect(body.skipped).toHaveLength(2);
      expect(body.skipped.map((s: { reason: string }) => s.reason)).toEqual([
        "price must be a positive number",
        "price must be a positive number",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("tenant-scoped: businessId from closure passed to createOnboardingProduct", async () => {
    createOnboardingProductMock.mockResolvedValue({ productId: "p-4", name: "X" });
    const { client, cleanup } = await buildConnectedClient("closure-cat-biz");
    try {
      await client.callTool({
        name: "upload_catalog",
        arguments: { products: [{ name: "Item", price: 100 }] },
      });
      expect(createOnboardingProductMock).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: "closure-cat-biz" }),
      );
    } finally {
      await cleanup();
    }
  });

  it("Zod schema rejects more than 50 items", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-cat-04");
    try {
      const over50 = Array.from({ length: 51 }, (_, i) => ({ name: `P${i}`, price: 100 }));
      const raw = await client.callTool({
        name: "upload_catalog",
        arguments: { products: over50 },
      });
      const result = asToolResult(raw);
      // Zod validation failure → isError: true
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
