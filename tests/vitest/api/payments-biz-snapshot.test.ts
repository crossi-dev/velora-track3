// Tests for Phase 2 S3:
//  1. GET /api/internal/agents/biz-snapshot route (auth + DB → response shape)
//  2. prefetchBizSnapshot helper (happy path shape match + failure → clean error)

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── shared hoisted mocks ─────────────────────────────────────────────────────

const { prismaBusinessFindUnique, prismaMpConnectionFindUnique, cloudLogMock, fetchMock } =
  vi.hoisted(() => ({
    prismaBusinessFindUnique: vi.fn(),
    prismaMpConnectionFindUnique: vi.fn(),
    cloudLogMock: vi.fn(),
    fetchMock: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: prismaBusinessFindUnique },
    mpConnection: { findUnique: prismaMpConnectionFindUnique },
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

// ── Section 1: biz-snapshot route ───────────────────────────────────────────

describe("GET /api/internal/agents/biz-snapshot", () => {
  // Import the handler inline so env vars are already set when the module loads.
  // The route signature uses NextRequest but accepts a compatible Request in tests;
  // cast through unknown to satisfy TypeScript's strict parameter compatibility check.
  const importRoute = () =>
    import(
      "@/app/api/internal/agents/biz-snapshot/route"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test cast: NextRequest parameter accepts compatible Request in vitest
    ) as Promise<{ GET: (req: any) => Promise<Response> }>;

  const bizRow = {
    userId: "user-1",
    name: "Demo Store",
    paymentProvider: "mp",
    postalCode: "5500",
    alias: "demo.alias",
    whatsappPhone: "+5491122334455",
    cuit: "20123456789",
    courierPreference: "andreani",
  };
  const mpRow = {
    accessTokenCiphertext: "encrypted-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scope: "offline_access",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { GET } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/biz-snapshot?businessId=biz1");
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when bearer token is wrong", async () => {
    const { GET } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/biz-snapshot?businessId=biz1", {
      headers: { Authorization: "Bearer wrong-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when businessId is missing", async () => {
    const { GET } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/biz-snapshot", {
      headers: { Authorization: "Bearer test-secret-123" },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("returns 404 when business does not exist", async () => {
    prismaBusinessFindUnique.mockResolvedValueOnce(null);
    prismaMpConnectionFindUnique.mockResolvedValueOnce(null);
    const { GET } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/biz-snapshot?businessId=unknown", {
      headers: { Authorization: "Bearer test-secret-123" },
    });
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it("returns the business + mpConnection fields in the correct shape", async () => {
    prismaBusinessFindUnique.mockResolvedValueOnce(bizRow);
    prismaMpConnectionFindUnique.mockResolvedValueOnce(mpRow);
    const { GET } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/biz-snapshot?businessId=biz1", {
      headers: { Authorization: "Bearer test-secret-123" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      business: Record<string, unknown>;
      mpConnection: Record<string, unknown> | null;
    };
    expect(body.business.name).toBe("Demo Store");
    expect(body.business.paymentProvider).toBe("mp");
    expect(body.business.userId).toBe("user-1");
    expect(body.mpConnection).not.toBeNull();
    expect(body.mpConnection?.accessTokenCiphertext).toBe("encrypted-token");
  });

  it("returns null mpConnection when no MP row exists", async () => {
    prismaBusinessFindUnique.mockResolvedValueOnce(bizRow);
    prismaMpConnectionFindUnique.mockResolvedValueOnce(null);
    const { GET } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/biz-snapshot?businessId=biz1", {
      headers: { Authorization: "Bearer test-secret-123" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { mpConnection: null };
    expect(body.mpConnection).toBeNull();
  });

  it("returns 500 on DB error", async () => {
    prismaBusinessFindUnique.mockRejectedValueOnce(new Error("connection timeout"));
    prismaMpConnectionFindUnique.mockRejectedValueOnce(new Error("connection timeout"));
    const { GET } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/biz-snapshot?businessId=biz1", {
      headers: { Authorization: "Bearer test-secret-123" },
    });
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});

// ── Section 2: prefetchBizSnapshot helper ───────────────────────────────────

// We test the helper via a mocked global fetch — the helper uses VELORA_APP_URL
// and CRON_SECRET env vars (already set above).

vi.stubGlobal("fetch", fetchMock);

describe("prefetchBizSnapshot", () => {
  const importHelper = () =>
    import(
      "@/app/api/agents/payments/jsonrpc/_lib/payments-biz-prefetch"
    ) as Promise<typeof import("@/app/api/agents/payments/jsonrpc/_lib/payments-biz-prefetch")>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const okApiResponse = {
    business: {
      userId: "user-1",
      name: "Demo Store",
      paymentProvider: "mp",
      postalCode: "5500",
      alias: "demo.alias",
      whatsappPhone: "+5491122334455",
      cuit: "20123456789",
      courierPreference: "andreani",
    },
    mpConnection: {
      accessTokenCiphertext: "enc-token",
      expiresAt: "2027-01-01T00:00:00.000Z",
      scope: "offline_access",
    },
  };

  it("happy path: returns actorUserId + fully formed BizSnapshot", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => okApiResponse,
    });

    const { prefetchBizSnapshot } = await importHelper();
    const result = await prefetchBizSnapshot("biz-123");

    expect(result.actorUserId).toBe("user-1");
    expect(result.bizSnapshot).not.toBeNull();
    const snap = result.bizSnapshot!;
    expect(snap.name).toBe("Demo Store");
    expect(snap.paymentProvider).toBe("mp");
    expect(snap.hasMpConnection).toBe(true);
    expect(snap.mpConnectionRaw?.accessTokenCiphertext).toBe("enc-token");
    // Date rehydration from ISO string
    expect(snap.mpConnectionRaw?.expiresAt).toBeInstanceOf(Date);
    expect(snap.courierPreference).toBe("andreani");
  });

  it("happy path: null mpConnection → hasMpConnection false, mpConnectionRaw null", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...okApiResponse, mpConnection: null }),
    });

    const { prefetchBizSnapshot } = await importHelper();
    const result = await prefetchBizSnapshot("biz-123");

    expect(result.bizSnapshot?.hasMpConnection).toBe(false);
    expect(result.bizSnapshot?.mpConnectionRaw).toBeNull();
  });

  it("404 from core → returns null snapshot (business not found)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ code: "NOT_FOUND", message: "Business not found." }),
    });

    const { prefetchBizSnapshot } = await importHelper();
    const result = await prefetchBizSnapshot("biz-nonexistent");

    expect(result.actorUserId).toBeNull();
    expect(result.bizSnapshot).toBeNull();
  });

  it("non-200 non-404 response → throws BizPrefetchHttpError", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ code: "INTERNAL_ERROR" }),
    });

    const { prefetchBizSnapshot, BizPrefetchHttpError } = await importHelper();
    await expect(prefetchBizSnapshot("biz-123")).rejects.toBeInstanceOf(BizPrefetchHttpError);
  });

  it("network error → throws BizPrefetchHttpError", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { prefetchBizSnapshot, BizPrefetchHttpError } = await importHelper();
    await expect(prefetchBizSnapshot("biz-123")).rejects.toBeInstanceOf(BizPrefetchHttpError);
  });

  it("correct URL uses VELORA_APP_URL not AGENTS_BASE_URL", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => okApiResponse,
    });

    const { prefetchBizSnapshot } = await importHelper();
    await prefetchBizSnapshot("biz-abc");

    const calledUrl: string = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("http://localhost:3000/api/internal/agents/biz-snapshot");
    expect(calledUrl).toContain("businessId=biz-abc");
  });

  it("Authorization header uses CRON_SECRET bearer", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => okApiResponse,
    });

    const { prefetchBizSnapshot } = await importHelper();
    await prefetchBizSnapshot("biz-abc");

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-secret-123");
  });
});
