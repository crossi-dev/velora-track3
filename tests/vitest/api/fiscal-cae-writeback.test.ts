// Tests for Phase 2 S5:
//  1. PATCH /api/internal/agents/invoice-cae route (auth + DB write → response shape)
//  2. writebackCae helper (success path; failure → clean FiscalCaeWritebackError)

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── shared hoisted mocks ─────────────────────────────────────────────────────

const { prismaInvoicePersistCae, cloudLogMock, fetchMock } = vi.hoisted(() => ({
  prismaInvoicePersistCae: vi.fn(),
  cloudLogMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/infrastructure/persistence/prisma-invoice.repository", () => ({
  prismaInvoiceRepository: {
    persistCaeFields: prismaInvoicePersistCae,
  },
}));

vi.mock("@/lib/cloud-logger", () => ({
  cloudLog: cloudLogMock,
  reportError: vi.fn(),
  runWithTraceContext: vi.fn((_, fn: () => unknown) => fn()),
}));

// Stub CRON_SECRET so auth passes in the handler test
process.env.CRON_SECRET = "test-secret-123";
// Stub VELORA_APP_URL so getCoreBaseUrl returns predictably
process.env.VELORA_APP_URL = "http://localhost:3000";

// ── Section 1: PATCH /api/internal/agents/invoice-cae ───────────────────────

describe("PATCH /api/internal/agents/invoice-cae", () => {
  const importRoute = () =>
    import(
      "@/app/api/internal/agents/invoice-cae/route"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test cast: NextRequest parameter accepts compatible Request in vitest
    ) as Promise<{ PATCH: (req: any) => Promise<Response> }>;

  const validBody = {
    businessId: "biz_abc123def456ghi",
    invoiceId: "inv_xyz789",
    caeCode: "12345678901234",
    caeFchVto: "2026-07-31T00:00:00.000Z",
    fiscalTipo: 6,
    fiscalPtoVta: 1,
    fiscalNumero: 42,
    fiscalEmittedAt: "2026-06-01T12:00:00.000Z",
    fiscalQrUrl: "https://www.afip.gob.ar/fe/qr/?p=abc123",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prismaInvoicePersistCae.mockResolvedValue({ persisted: true });
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { PATCH } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/invoice-cae", {
      method: "PATCH",
      body: JSON.stringify(validBody),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(401);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when bearer token is wrong", async () => {
    const { PATCH } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/invoice-cae", {
      method: "PATCH",
      body: JSON.stringify(validBody),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-secret",
      },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when body is missing required field (caeCode)", async () => {
    const { PATCH } = await importRoute();
    const { caeCode: _, ...withoutCaeCode } = validBody;
    const req = new Request("http://localhost/api/internal/agents/invoice-cae", {
      method: "PATCH",
      body: JSON.stringify(withoutCaeCode),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when fiscalEmittedAt is not a valid ISO date", async () => {
    const { PATCH } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/invoice-cae", {
      method: "PATCH",
      body: JSON.stringify({ ...validBody, fiscalEmittedAt: "not-a-date" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when caeFchVto is provided but not a valid ISO date", async () => {
    const { PATCH } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/invoice-cae", {
      method: "PATCH",
      body: JSON.stringify({ ...validBody, caeFchVto: "20260731" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("writes CAE scoped by businessId+invoiceId on success", async () => {
    const { PATCH } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/invoice-cae", {
      method: "PATCH",
      body: JSON.stringify(validBody),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(prismaInvoicePersistCae).toHaveBeenCalledOnce();
    const callArgs = prismaInvoicePersistCae.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.businessId).toBe(validBody.businessId);
    expect(callArgs.invoiceId).toBe(validBody.invoiceId);
    expect(callArgs.caeCode).toBe(validBody.caeCode);
    expect(callArgs.fiscalNumero).toBe(validBody.fiscalNumero);
    expect(callArgs.caeFchVto).toBeInstanceOf(Date);
    expect(callArgs.fiscalEmittedAt).toBeInstanceOf(Date);
  });

  it("accepts null caeFchVto and null fiscalQrUrl", async () => {
    const { PATCH } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/invoice-cae", {
      method: "PATCH",
      body: JSON.stringify({ ...validBody, caeFchVto: null, fiscalQrUrl: null }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const callArgs = prismaInvoicePersistCae.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.caeFchVto).toBeNull();
    expect(callArgs.fiscalQrUrl).toBeNull();
  });

  it("returns 404 when persistCaeFields returns persisted=false (foreign invoiceId / DB error)", async () => {
    prismaInvoicePersistCae.mockResolvedValueOnce({ persisted: false });
    const { PATCH } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/invoice-cae", {
      method: "PATCH",
      body: JSON.stringify({ ...validBody, invoiceId: "inv_other_tenant" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("NOT_FOUND");
  });

  it("does not allow cross-tenant write — businessId scopes the DB update", async () => {
    const { PATCH } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/invoice-cae", {
      method: "PATCH",
      body: JSON.stringify({ ...validBody, businessId: "biz_tenant_a" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    await PATCH(req);
    const callArgs = prismaInvoicePersistCae.mock.calls[0]?.[0] as Record<string, unknown>;
    // Confirm the repo receives the exact businessId without mutation
    expect(callArgs.businessId).toBe("biz_tenant_a");
  });
});

// ── Section 2: writebackCae helper ──────────────────────────────────────────

vi.stubGlobal("fetch", fetchMock);

describe("writebackCae", () => {
  const importHelper = () =>
    import(
      "@/app/api/agents/fiscal/jsonrpc/_lib/cae-writeback"
    ) as Promise<typeof import("@/app/api/agents/fiscal/jsonrpc/_lib/cae-writeback")>;

  const baseArgs = {
    businessId: "biz_abc123def456ghi",
    invoiceId: "inv_xyz789",
    caeCode: "12345678901234",
    caeFchVto: new Date("2026-07-31T00:00:00.000Z"),
    fiscalTipo: 6,
    fiscalPtoVta: 1,
    fiscalNumero: 42,
    fiscalEmittedAt: new Date("2026-06-01T12:00:00.000Z"),
    fiscalQrUrl: "https://www.afip.gob.ar/fe/qr/?p=abc123",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves (void) on 200 success from core", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { writebackCae } = await importHelper();
    await expect(writebackCae(baseArgs)).resolves.toBeUndefined();
  });

  it("calls the correct core URL with PATCH method", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { writebackCae } = await importHelper();
    await writebackCae(baseArgs);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("http://localhost:3000/api/internal/agents/invoice-cae");
    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(calledInit.method).toBe("PATCH");
  });

  it("Authorization header uses CRON_SECRET bearer", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { writebackCae } = await importHelper();
    await writebackCae(baseArgs);

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-secret-123");
  });

  it("body contains all required fields with Dates serialized as ISO strings", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { writebackCae } = await importHelper();
    await writebackCae(baseArgs);

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(sentBody.businessId).toBe(baseArgs.businessId);
    expect(sentBody.invoiceId).toBe(baseArgs.invoiceId);
    expect(sentBody.caeCode).toBe(baseArgs.caeCode);
    expect(sentBody.fiscalNumero).toBe(baseArgs.fiscalNumero);
    expect(typeof sentBody.fiscalEmittedAt).toBe("string");
    expect(new Date(sentBody.fiscalEmittedAt as string).toISOString()).toBe(
      baseArgs.fiscalEmittedAt.toISOString(),
    );
    expect(typeof sentBody.caeFchVto).toBe("string");
    expect(new Date(sentBody.caeFchVto as string).toISOString()).toBe(
      baseArgs.caeFchVto.toISOString(),
    );
  });

  it("sends null caeFchVto when input is null", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { writebackCae } = await importHelper();
    await writebackCae({ ...baseArgs, caeFchVto: null });

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(sentBody.caeFchVto).toBeNull();
  });

  it("non-200 response → throws FiscalCaeWritebackError (hard stop)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const { writebackCae, FiscalCaeWritebackError } = await importHelper();
    await expect(writebackCae(baseArgs)).rejects.toBeInstanceOf(FiscalCaeWritebackError);
  });

  it("404 from core → throws FiscalCaeWritebackError with status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const { writebackCae, FiscalCaeWritebackError } = await importHelper();
    const err = await writebackCae(baseArgs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FiscalCaeWritebackError);
    expect((err as InstanceType<typeof FiscalCaeWritebackError>).status).toBe(404);
  });

  it("network error → throws FiscalCaeWritebackError (no silent success)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { writebackCae, FiscalCaeWritebackError } = await importHelper();
    await expect(writebackCae(baseArgs)).rejects.toBeInstanceOf(FiscalCaeWritebackError);
  });
});
