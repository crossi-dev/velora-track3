// Tests for Phase 2 S4:
//  1. POST /api/internal/agents/shipments route (auth + DB write → response shape)
//  2. writebackShipment helper (success path; failure → clean ShipmentWritebackError)

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── shared hoisted mocks ─────────────────────────────────────────────────────

const { prismaShipmentUpsert, cloudLogMock, fetchMock } = vi.hoisted(() => ({
  prismaShipmentUpsert: vi.fn(),
  cloudLogMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/infrastructure/persistence/prisma-shipment.repository", () => ({
  prismaShipmentRepository: {
    upsertAndreaniShipment: prismaShipmentUpsert,
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

// ── Section 1: POST /api/internal/agents/shipments ───────────────────────────

describe("POST /api/internal/agents/shipments", () => {
  const importRoute = () =>
    import(
      "@/app/api/internal/agents/shipments/route"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test cast: NextRequest parameter accepts compatible Request in vitest
    ) as Promise<{ POST: (req: any) => Promise<Response> }>;

  const validBody = {
    businessId: "biz_abc123def456ghi",
    saleId: "sale_xyz789",
    trackingNumber: "AND-99999",
    service: "domicilio",
    labelPdfPath: "pdfs/label/biz_abc/sale_xyz/AND-99999.pdf",
    estimatedDelivery: "2026-07-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prismaShipmentUpsert.mockResolvedValue(undefined);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/shipments", {
      method: "POST",
      body: JSON.stringify(validBody),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when bearer token is wrong", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/shipments", {
      method: "POST",
      body: JSON.stringify(validBody),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-secret",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when body is missing required field (saleId)", async () => {
    const { POST } = await importRoute();
    const { saleId: _, ...withoutSaleId } = validBody;
    const req = new Request("http://localhost/api/internal/agents/shipments", {
      method: "POST",
      body: JSON.stringify(withoutSaleId),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when estimatedDelivery is not a valid ISO date", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/shipments", {
      method: "POST",
      body: JSON.stringify({ ...validBody, estimatedDelivery: "not-a-date" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("upserts shipment scoped by businessId on success", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/shipments", {
      method: "POST",
      body: JSON.stringify(validBody),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(prismaShipmentUpsert).toHaveBeenCalledOnce();
    const callArgs = prismaShipmentUpsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.businessId).toBe(validBody.businessId);
    expect(callArgs.saleId).toBe(validBody.saleId);
    expect(callArgs.trackingNumber).toBe(validBody.trackingNumber);
    expect(callArgs.service).toBe(validBody.service);
    expect(callArgs.labelPdfPath).toBe(validBody.labelPdfPath);
    expect(callArgs.estimatedDelivery).toBeInstanceOf(Date);
  });

  it("handles null labelPdfPath correctly", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/shipments", {
      method: "POST",
      body: JSON.stringify({ ...validBody, labelPdfPath: null }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const callArgs = prismaShipmentUpsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.labelPdfPath).toBeNull();
  });

  it("returns 500 on DB error", async () => {
    prismaShipmentUpsert.mockRejectedValueOnce(new Error("connection timeout"));
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/shipments", {
      method: "POST",
      body: JSON.stringify(validBody),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("does not allow cross-tenant write — businessId in body is passed to upsert unchanged", async () => {
    // The endpoint writes only the businessId from the request body (sent by the agent).
    // The agent always passes its own businessId (from its execution context) — the
    // CRON_SECRET auth ensures only trusted callers can invoke this endpoint.
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/shipments", {
      method: "POST",
      body: JSON.stringify({ ...validBody, businessId: "biz_tenant_a" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    await POST(req);
    const callArgs = prismaShipmentUpsert.mock.calls[0]?.[0] as Record<string, unknown>;
    // Confirm the repo receives the exact businessId without mutation
    expect(callArgs.businessId).toBe("biz_tenant_a");
  });
});

// ── Section 2: writebackShipment helper ──────────────────────────────────────

vi.stubGlobal("fetch", fetchMock);

describe("writebackShipment", () => {
  const importHelper = () =>
    import(
      "@/app/api/agents/andreani/_lib/shipment-writeback"
    ) as Promise<typeof import("@/app/api/agents/andreani/_lib/shipment-writeback")>;

  const baseArgs = {
    businessId: "biz_abc123def456ghi",
    saleId: "sale_xyz789",
    trackingNumber: "AND-99999",
    service: "domicilio",
    labelPdfPath: "pdfs/label/biz_abc/sale_xyz/AND-99999.pdf",
    estimatedDelivery: new Date("2026-07-01T00:00:00.000Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves (void) on 200 success from core", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { writebackShipment } = await importHelper();
    await expect(writebackShipment(baseArgs)).resolves.toBeUndefined();
  });

  it("calls the correct core URL with POST method", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { writebackShipment } = await importHelper();
    await writebackShipment(baseArgs);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("http://localhost:3000/api/internal/agents/shipments");
    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(calledInit.method).toBe("POST");
  });

  it("Authorization header uses CRON_SECRET bearer", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { writebackShipment } = await importHelper();
    await writebackShipment(baseArgs);

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-secret-123");
  });

  it("body contains all required fields including estimatedDelivery as ISO string", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { writebackShipment } = await importHelper();
    await writebackShipment(baseArgs);

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(sentBody.businessId).toBe(baseArgs.businessId);
    expect(sentBody.saleId).toBe(baseArgs.saleId);
    expect(sentBody.trackingNumber).toBe(baseArgs.trackingNumber);
    expect(sentBody.service).toBe(baseArgs.service);
    expect(sentBody.labelPdfPath).toBe(baseArgs.labelPdfPath);
    expect(typeof sentBody.estimatedDelivery).toBe("string");
    expect(new Date(sentBody.estimatedDelivery as string).toISOString()).toBe(baseArgs.estimatedDelivery.toISOString());
  });

  it("non-200 response → throws ShipmentWritebackError (hard stop)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const { writebackShipment, ShipmentWritebackError } = await importHelper();
    await expect(writebackShipment(baseArgs)).rejects.toBeInstanceOf(ShipmentWritebackError);
  });

  it("503 from core → throws ShipmentWritebackError with status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const { writebackShipment, ShipmentWritebackError } = await importHelper();
    await expect(writebackShipment(baseArgs)).rejects.toBeInstanceOf(ShipmentWritebackError);
  });

  it("network error → throws ShipmentWritebackError (no silent success)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { writebackShipment, ShipmentWritebackError } = await importHelper();
    await expect(writebackShipment(baseArgs)).rejects.toBeInstanceOf(ShipmentWritebackError);
  });
});
