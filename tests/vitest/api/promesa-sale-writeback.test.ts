// Tests for Phase 2 Payments promesa-sale HTTP cutover:
//  1. POST /api/internal/agents/promesa-sale route
//     (auth + field validation + expectedAt Date reconstruction + use-case call → response shape)
//  2. callPromesaSaleEndpoint helper
//     (success path; failure → clean PromesaSaleWritebackError; expectedAt serialisation)
//  3. Flag gate — isPromesaSaleOverHttpEnabled() (flag OFF → in-process; flag ON → HTTP client)
//
// Structure mirrors tests/vitest/api/payments-link-sale-writeback.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── shared hoisted mocks ─────────────────────────────────────────────────────

const { registerPromesaUseCaseMock, cloudLogMock, fetchMock } = vi.hoisted(() => ({
  registerPromesaUseCaseMock: vi.fn(),
  cloudLogMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock(
  "@/app/api/payment-intents/_lib/register-promesa-sale-use-case",
  () => ({
    registerPromesaSaleUseCase: registerPromesaUseCaseMock,
  }),
);

vi.mock("@/lib/cloud-logger", () => ({
  cloudLog: cloudLogMock,
  reportError: vi.fn(),
  runWithTraceContext: vi.fn((_, fn: () => unknown) => fn()),
}));

// Stub CRON_SECRET + VELORA_APP_URL for all sections
process.env.CRON_SECRET = "test-secret-123";
process.env.VELORA_APP_URL = "http://localhost:3000";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const ISO_DATE = "2026-06-30T00:00:00.000Z";

// validInput uses the wire shape: expectedAt is an ISO string (Date serialised by JSON.stringify)
const validInput = {
  businessId: "biz_abc123def456ghi",
  actorUserId: "user_ownerABC",
  customerId: "cust_xyz789",
  items: [{ productId: "prod_111", quantity: 2 }],
  expectedAt: ISO_DATE,
};

const createdResult = {
  outcome: "created" as const,
  paymentIntentId: "pi_created123",
  saleId: "sale_created456",
  grandTotal: 9800,
};

const replayedResult = {
  outcome: "replayed" as const,
  paymentIntentId: "pi_created123",
  saleId: "sale_created456",
};

// ── Section 1: POST /api/internal/agents/promesa-sale ────────────────────────

describe("POST /api/internal/agents/promesa-sale", () => {
  const importRoute = () =>
    import(
      "@/app/api/internal/agents/promesa-sale/route"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test cast
    ) as Promise<{ POST: (req: any) => Promise<Response> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    registerPromesaUseCaseMock.mockResolvedValue(createdResult);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify(validInput),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when bearer token is wrong", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify(validInput),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-secret",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when body is missing businessId", async () => {
    const { POST } = await importRoute();
    const { businessId: _, ...withoutBusinessId } = validInput;
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify(withoutBusinessId),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when items array is empty", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify({ ...validInput, items: [] }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when expectedAt is missing", async () => {
    const { POST } = await importRoute();
    const { expectedAt: _, ...withoutExpectedAt } = validInput;
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify(withoutExpectedAt),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when expectedAt is not a valid ISO date string", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify({ ...validInput, expectedAt: "not-a-date" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("returns 200 with use-case result on success (created)", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify(validInput),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof createdResult;
    expect(body.outcome).toBe("created");
    expect(body.paymentIntentId).toBe(createdResult.paymentIntentId);
    expect(body.saleId).toBe(createdResult.saleId);
    expect(body.grandTotal).toBe(createdResult.grandTotal);
  });

  it("returns 200 with replayed outcome (idempotent replay)", async () => {
    registerPromesaUseCaseMock.mockResolvedValueOnce(replayedResult);
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify(validInput),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof replayedResult;
    expect(body.outcome).toBe("replayed");
  });

  it("returns 200 with customer_not_found outcome (business outcome, not HTTP error)", async () => {
    registerPromesaUseCaseMock.mockResolvedValueOnce({ outcome: "customer_not_found" });
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify(validInput),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("customer_not_found");
  });

  // CRITICAL: DIVERGENCE 1 correctness — the endpoint must reconstruct expectedAt
  // from the ISO string back into a Date before calling the use-case.
  // This test asserts the mock received a Date equal to the sent ISO value.
  it("reconstructs expectedAt from ISO string into a Date passed to use-case", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/promesa-sale", {
      method: "POST",
      body: JSON.stringify(validInput),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    await POST(req);
    expect(registerPromesaUseCaseMock).toHaveBeenCalledOnce();
    const callArg = registerPromesaUseCaseMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.businessId).toBe(validInput.businessId);
    expect(callArg.customerId).toBe(validInput.customerId);
    // expectedAt must be a Date (not a string), and must equal the sent ISO value
    expect(callArg.expectedAt).toBeInstanceOf(Date);
    expect((callArg.expectedAt as Date).toISOString()).toBe(ISO_DATE);
  });
});

// ── Section 2: callPromesaSaleEndpoint helper ────────────────────────────────
// Uses real fetch stub — does NOT vi.mock the writeback module.

vi.stubGlobal("fetch", fetchMock);

// For the client tests we pass the input with expectedAt as a Date (the type
// that the tool builds — by the time it reaches callPromesaSaleEndpoint the
// Date is already constructed from the LLM string by the execute() function).
const clientInput = {
  ...validInput,
  expectedAt: new Date(ISO_DATE),
};

describe("callPromesaSaleEndpoint", () => {
  const importHelper = () =>
    import(
      "@/app/api/agents/payments/jsonrpc/_lib/register-promesa-sale-writeback"
    ) as Promise<
      typeof import("@/app/api/agents/payments/jsonrpc/_lib/register-promesa-sale-writeback")
    >;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves with the parsed result on 200 success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createdResult,
    });
    const { callPromesaSaleEndpoint } = await importHelper();
    const result = await callPromesaSaleEndpoint(clientInput);
    expect(result.outcome).toBe("created");
    expect((result as typeof createdResult).paymentIntentId).toBe(createdResult.paymentIntentId);
  });

  it("calls the correct core URL with POST method", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createdResult,
    });
    const { callPromesaSaleEndpoint } = await importHelper();
    await callPromesaSaleEndpoint(clientInput);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("http://localhost:3000/api/internal/agents/promesa-sale");
    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(calledInit.method).toBe("POST");
  });

  it("Authorization header uses CRON_SECRET bearer", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createdResult,
    });
    const { callPromesaSaleEndpoint } = await importHelper();
    await callPromesaSaleEndpoint(clientInput);

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-secret-123");
  });

  // CRITICAL: DIVERGENCE 1 round-trip — the client serialises expectedAt (a Date)
  // to JSON; the endpoint reconstructs it. Verify the ISO string is sent correctly.
  it("serialises expectedAt Date to ISO string in the request body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createdResult,
    });
    const { callPromesaSaleEndpoint } = await importHelper();
    await callPromesaSaleEndpoint(clientInput);

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(sentBody.businessId).toBe(validInput.businessId);
    expect(sentBody.customerId).toBe(validInput.customerId);
    // JSON.stringify(Date) → ISO string — verify the round-trip value matches
    expect(sentBody.expectedAt).toBe(ISO_DATE);
  });

  it("non-200 response → throws PromesaSaleWritebackError (hard stop)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const { callPromesaSaleEndpoint, PromesaSaleWritebackError } = await importHelper();
    await expect(callPromesaSaleEndpoint(clientInput)).rejects.toBeInstanceOf(
      PromesaSaleWritebackError,
    );
  });

  it("503 from core → throws PromesaSaleWritebackError with status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const { callPromesaSaleEndpoint, PromesaSaleWritebackError } = await importHelper();
    const err = await callPromesaSaleEndpoint(clientInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PromesaSaleWritebackError);
    expect((err as InstanceType<typeof PromesaSaleWritebackError>).status).toBe(503);
  });

  it("network error → throws PromesaSaleWritebackError (no silent success)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { callPromesaSaleEndpoint, PromesaSaleWritebackError } = await importHelper();
    await expect(callPromesaSaleEndpoint(clientInput)).rejects.toBeInstanceOf(
      PromesaSaleWritebackError,
    );
  });
});

// ── Section 3: flag gate — isPromesaSaleOverHttpEnabled() ────────────────────
// Tests isPromesaSaleOverHttpEnabled() directly from the writeback module,
// verifying that the env var is read at call time (not module-load).

describe("isPromesaSaleOverHttpEnabled", () => {
  const importHelper = () =>
    import(
      "@/app/api/agents/payments/jsonrpc/_lib/register-promesa-sale-writeback"
    ) as Promise<
      typeof import("@/app/api/agents/payments/jsonrpc/_lib/register-promesa-sale-writeback")
    >;

  afterEach(() => {
    delete process.env.PROMESA_SALE_OVER_HTTP_ENABLED;
  });

  it("returns false when env var is not set", async () => {
    delete process.env.PROMESA_SALE_OVER_HTTP_ENABLED;
    const { isPromesaSaleOverHttpEnabled } = await importHelper();
    expect(isPromesaSaleOverHttpEnabled()).toBe(false);
  });

  it("returns false when env var is explicitly 'false'", async () => {
    process.env.PROMESA_SALE_OVER_HTTP_ENABLED = "false";
    const { isPromesaSaleOverHttpEnabled } = await importHelper();
    expect(isPromesaSaleOverHttpEnabled()).toBe(false);
  });

  it("returns true when env var is 'true'", async () => {
    process.env.PROMESA_SALE_OVER_HTTP_ENABLED = "true";
    const { isPromesaSaleOverHttpEnabled } = await importHelper();
    expect(isPromesaSaleOverHttpEnabled()).toBe(true);
  });

  it("reads env at call time — toggling env changes behavior without re-import", async () => {
    delete process.env.PROMESA_SALE_OVER_HTTP_ENABLED;
    const { isPromesaSaleOverHttpEnabled } = await importHelper();
    expect(isPromesaSaleOverHttpEnabled()).toBe(false);
    process.env.PROMESA_SALE_OVER_HTTP_ENABLED = "true";
    expect(isPromesaSaleOverHttpEnabled()).toBe(true);
    delete process.env.PROMESA_SALE_OVER_HTTP_ENABLED;
    expect(isPromesaSaleOverHttpEnabled()).toBe(false);
  });
});
