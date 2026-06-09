// tests/vitest/mcp/fiscal-delegation.test.ts
//
// Tests for Phase 4: ARCA delegation onboarding.
//
// Coverage:
//   1. connect-delegation route: upserts ArcaCredential with isProviderDelegation=true
//      and no cert; resolveActor must be owner.
//   2. loadCredential (via emit()): delegation row + provider env set → returns
//      Velora's certGcsPath + merchant CUIT.
//   3. loadCredential (via emit()): delegation row + env ABSENT → throws structured
//      setup error (not a crash).
//
// Mock seams:
//   @/lib/prisma        → arcaCredential.findUnique / upsert
//   @/app/api/_lib/resolve-actor → resolveActor + requireRole
//   @/lib/demo-testers  → isBusinessDemoTester
//   arca-real/wsaa      → getTicket (avoid network)
//   arca-real/wsfe      → emitInvoice (avoid network)
//   @/lib/secret-manager-tenant → getTenantSecret

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  prismaMock,
  resolveActorMock,
  requireRoleMock,
  isDemoTesterMock,
  getTicketMock,
  wsfeEmitMock,
  getTenantSecretMock,
  recordCriticalWriteEventMock,
} = vi.hoisted(() => {
  return {
    prismaMock: {
      arcaCredential: {
        findUnique: vi.fn(),
        upsert: vi.fn().mockResolvedValue({}),
      },
      business: {
        findUnique: vi.fn(),
      },
    },
    resolveActorMock: vi.fn(),
    requireRoleMock: vi.fn().mockReturnValue(null), // null = no role error
    isDemoTesterMock: vi.fn().mockResolvedValue(false),
    getTicketMock: vi.fn().mockResolvedValue({
      token: "tok",
      sign: "sig",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
    wsfeEmitMock: vi.fn().mockResolvedValue({
      sandbox: false,
      cae: "66000000000001",
      vencimientoCae: "20260611",
      numero: 1,
      tipoComprobante: 11,
      puntoVenta: 1,
      issuedAt: "2026-06-01T00:00:00.000Z",
    }),
    getTenantSecretMock: vi.fn().mockResolvedValue("provider-passphrase"),
    recordCriticalWriteEventMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/app/api/_lib/resolve-actor", () => ({
  resolveActor: resolveActorMock,
  requireRole: requireRoleMock,
}));

vi.mock("@/lib/demo-testers", () => ({
  isBusinessDemoTester: isDemoTesterMock,
}));

vi.mock("@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/wsaa", () => ({
  getTicket: getTicketMock,
  evictTicket: vi.fn(),
}));

vi.mock("@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/wsfe", () => ({
  emitInvoice: wsfeEmitMock,
}));

vi.mock("@/lib/secret-manager-tenant", () => ({
  getTenantSecret: getTenantSecretMock,
  storeTenantSecret: vi.fn(),
  tenantSecretId: vi.fn(),
}));

vi.mock("@/infrastructure/shared/critical-write-audit", () => ({
  recordCriticalWriteEvent: recordCriticalWriteEventMock,
}));

vi.mock("@velora/core-utils/mp-token-cipher", () => ({
  decrypt: vi.fn().mockReturnValue("fake-passphrase"),
}));

// Rate limit + route helpers — bypass all guards.
vi.mock("@/app/api/_lib/route-helpers", () => ({
  bypassIfTester: vi.fn().mockReturnValue({ bypass: true }),
  checkRateLimit: vi.fn().mockReturnValue(null),
  jsonError: vi.fn((code: string, message: string, status: number) => {
    const r = new Response(JSON.stringify({ code, message }), { status });
    Object.defineProperty(r, "_jsonError", { value: { code, message, status } });
    return r;
  }),
  internalError: vi.fn((message: string) => {
    const r = new Response(JSON.stringify({ code: "INTERNAL_ERROR", message }), { status: 500 });
    Object.defineProperty(r, "_jsonError", { value: { code: "INTERNAL_ERROR", message, status: 500 } });
    return r;
  }),
  logRouteError: vi.fn(),
}));

// NextResponse.json stub
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    NextResponse: {
      json: vi.fn((body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), { status: 200, ...init }),
      ),
    },
  };
});

// ── Subjects under test ───────────────────────────────────────────────────────

// Import AFTER mocks.
// eslint-disable-next-line import/order
import { POST } from "@/app/api/integrations/fiscal/connect-delegation/route";
// eslint-disable-next-line import/order
import { emit } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/integrations/fiscal/connect-delegation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const OWNER_CTX = {
  businessId: "biz-deleg-test",
  actorUserId: "user-owner-1",
  actorEmployeeId: null,
  role: "owner",
};

const DELEGATION_ROW = {
  businessId: "biz-deleg-test",
  cuit: "30071234567",
  puntoVenta: 1,
  condicionIva: "MT",
  certGcsPath: "", // empty — delegation mode
  encryptedPassphrase: null,
  passphraseSecretName: null,
  environment: "production",
  isProviderDelegation: true,
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe("connect-delegation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActorMock.mockResolvedValue(OWNER_CTX);
    requireRoleMock.mockReturnValue(null);
    prismaMock.business.findUnique.mockResolvedValue({ cuit: "30071234567" });
    prismaMock.arcaCredential.upsert.mockResolvedValue({});
    recordCriticalWriteEventMock.mockResolvedValue(undefined);
  });

  it("upserts ArcaCredential with isProviderDelegation=true and no cert fields", async () => {
    const req = makeRequest({ puntoVenta: 1, condicionIva: "MT" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);

    expect(prismaMock.arcaCredential.upsert).toHaveBeenCalledOnce();
    const call = prismaMock.arcaCredential.upsert.mock.calls[0]?.[0];
    // Both create and update must set isProviderDelegation=true
    expect(call.create.isProviderDelegation).toBe(true);
    expect(call.update.isProviderDelegation).toBe(true);
    // certGcsPath must be empty sentinel (no cert uploaded)
    expect(call.create.certGcsPath).toBe("");
    expect(call.update.certGcsPath).toBe("");
    // merchant CUIT from Business row
    expect(call.create.cuit).toBe("30071234567");
    // encryptedPassphrase cleared on update
    expect(call.update.encryptedPassphrase).toBeNull();
    expect(call.update.passphraseSecretName).toBeNull();
  });

  it("returns 422 when business has no CUIT", async () => {
    prismaMock.business.findUnique.mockResolvedValue({ cuit: null });
    const req = makeRequest({ puntoVenta: 1, condicionIva: "RI" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(422);
    expect(prismaMock.arcaCredential.upsert).not.toHaveBeenCalled();
  });

  it("returns 401 when no actor", async () => {
    resolveActorMock.mockResolvedValue(null);
    const req = makeRequest({ puntoVenta: 1, condicionIva: "RI" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid puntoVenta", async () => {
    const req = makeRequest({ puntoVenta: 0, condicionIva: "MT" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_PUNTO_VENTA");
  });

  it("returns 400 on invalid condicionIva", async () => {
    const req = makeRequest({ puntoVenta: 1, condicionIva: "XX" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CONDICION_IVA");
  });
});

describe("emit() — delegation loadCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isDemoTesterMock.mockResolvedValue(false);
    getTicketMock.mockResolvedValue({ token: "tok", sign: "sig", expiresAt: "2099-01-01T00:00:00Z" });
    wsfeEmitMock.mockResolvedValue({
      sandbox: false,
      cae: "66000000000001",
      vencimientoCae: "20260611",
      numero: 1,
      tipoComprobante: 11,
      puntoVenta: 1,
      issuedAt: "2026-06-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    delete process.env.ARCA_REAL_MODE;
    delete process.env.ARCA_PRODUCTION;
    delete process.env.VELORA_PROVIDER_CERT_GCS_PATH;
    delete process.env.VELORA_PROVIDER_PASSPHRASE_SECRET;
  });

  it("uses Velora provider cert + merchant CUIT when delegation row + env set", async () => {
    process.env.ARCA_REAL_MODE = "true";
    process.env.ARCA_PRODUCTION = "false";
    process.env.VELORA_PROVIDER_CERT_GCS_PATH = "provider/velora-provider.p12";
    process.env.VELORA_PROVIDER_PASSPHRASE_SECRET = "arca-passphrase";

    prismaMock.arcaCredential.findUnique.mockResolvedValue(DELEGATION_ROW);
    getTenantSecretMock.mockResolvedValue("provider-passphrase");

    await emit({
      businessId: "biz-deleg-test",
      customerCuit: "20123456789",
      amountARS: 1000,
      tipo: "C",
    });

    // getTicket must have been called with certGcsPath = Velora's provider cert
    expect(getTicketMock).toHaveBeenCalledOnce();
    const credentialPassedToGetTicket = getTicketMock.mock.calls[0]?.[0];
    expect(credentialPassedToGetTicket.certGcsPath).toBe("provider/velora-provider.p12");
    // merchant CUIT is preserved
    expect(credentialPassedToGetTicket.cuit).toBe("30071234567");

    // getTenantSecret must have used "velora-provider" as the synthetic businessId
    expect(getTenantSecretMock).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "velora-provider" }),
    );
  });

  it("throws structured setup error when delegation row + provider env ABSENT", async () => {
    process.env.ARCA_REAL_MODE = "true";
    // VELORA_PROVIDER_CERT_GCS_PATH and VELORA_PROVIDER_PASSPHRASE_SECRET not set

    prismaMock.arcaCredential.findUnique.mockResolvedValue(DELEGATION_ROW);

    await expect(
      emit({
        businessId: "biz-deleg-test",
        customerCuit: "20123456789",
        amountARS: 1000,
        tipo: "C",
      }),
    ).rejects.toThrow(
      "La facturación electrónica por delegación aún no está habilitada.",
    );
  });
});
