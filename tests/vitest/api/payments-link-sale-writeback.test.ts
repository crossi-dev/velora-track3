// Tests for Phase 2 Payments HTTP cutover:
//  1. POST /api/internal/agents/payment-link-sale route (auth + use-case call → response shape)
//  2. callPaymentLinkSaleEndpoint helper (success path; failure → clean PaymentLinkSaleWritebackError)
//  3. Flag gate in payments-agent-tools (flag OFF → in-process; flag ON → HTTP client)
//
// Structure mirrors tests/vitest/api/andreani-shipment-writeback.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── shared hoisted mocks ─────────────────────────────────────────────────────

const { registerSaleUseCaseMock, cloudLogMock, fetchMock } = vi.hoisted(() => ({
  registerSaleUseCaseMock: vi.fn(),
  cloudLogMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock(
  "@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case",
  () => ({
    registerSaleWithPaymentLinkUseCase: registerSaleUseCaseMock,
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

const validInput = {
  businessId: "biz_abc123def456ghi",
  actorUserId: "user_ownerABC",
  customerId: "cust_xyz789",
  items: [{ productId: "prod_111", quantity: 2 }],
  description: "Pedido cliente WPP",
  idempotencyKey: "idem_biz_abc_20260601_001",
  shippingRequired: false,
  shippingAddress: null,
  shippingCostARS: null,
  shippingCourier: null,
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

// ── Section 1: POST /api/internal/agents/payment-link-sale ───────────────────

describe("POST /api/internal/agents/payment-link-sale", () => {
  const importRoute = () =>
    import(
      "@/app/api/internal/agents/payment-link-sale/route"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test cast
    ) as Promise<{ POST: (req: any) => Promise<Response> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    registerSaleUseCaseMock.mockResolvedValue(createdResult);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/payment-link-sale", {
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
    const req = new Request("http://localhost/api/internal/agents/payment-link-sale", {
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
    const req = new Request("http://localhost/api/internal/agents/payment-link-sale", {
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
    const req = new Request("http://localhost/api/internal/agents/payment-link-sale", {
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

  it("returns 400 when idempotencyKey is missing", async () => {
    const { POST } = await importRoute();
    const { idempotencyKey: _, ...withoutKey } = validInput;
    const req = new Request("http://localhost/api/internal/agents/payment-link-sale", {
      method: "POST",
      body: JSON.stringify(withoutKey),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 200 with use-case result on success (created)", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/payment-link-sale", {
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
    registerSaleUseCaseMock.mockResolvedValueOnce(replayedResult);
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/payment-link-sale", {
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
    registerSaleUseCaseMock.mockResolvedValueOnce({ outcome: "customer_not_found" });
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/payment-link-sale", {
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

  it("passes idempotencyKey to use-case unchanged", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/internal/agents/payment-link-sale", {
      method: "POST",
      body: JSON.stringify(validInput),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-123",
      },
    });
    await POST(req);
    expect(registerSaleUseCaseMock).toHaveBeenCalledOnce();
    const callArg = registerSaleUseCaseMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.idempotencyKey).toBe(validInput.idempotencyKey);
    expect(callArg.businessId).toBe(validInput.businessId);
    expect(callArg.customerId).toBe(validInput.customerId);
  });
});

// ── Section 2: callPaymentLinkSaleEndpoint helper ────────────────────────────
// Uses real fetch stub — does NOT vi.mock the writeback module.

vi.stubGlobal("fetch", fetchMock);

describe("callPaymentLinkSaleEndpoint", () => {
  const importHelper = () =>
    import(
      "@/app/api/agents/payments/jsonrpc/_lib/payment-link-sale-writeback"
    ) as Promise<
      typeof import("@/app/api/agents/payments/jsonrpc/_lib/payment-link-sale-writeback")
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
    const { callPaymentLinkSaleEndpoint } = await importHelper();
    const result = await callPaymentLinkSaleEndpoint(validInput);
    expect(result.outcome).toBe("created");
    expect((result as typeof createdResult).paymentIntentId).toBe(createdResult.paymentIntentId);
  });

  it("calls the correct core URL with POST method", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createdResult,
    });
    const { callPaymentLinkSaleEndpoint } = await importHelper();
    await callPaymentLinkSaleEndpoint(validInput);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("http://localhost:3000/api/internal/agents/payment-link-sale");
    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(calledInit.method).toBe("POST");
  });

  it("Authorization header uses CRON_SECRET bearer", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createdResult,
    });
    const { callPaymentLinkSaleEndpoint } = await importHelper();
    await callPaymentLinkSaleEndpoint(validInput);

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-secret-123");
  });

  it("body contains idempotencyKey unchanged", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createdResult,
    });
    const { callPaymentLinkSaleEndpoint } = await importHelper();
    await callPaymentLinkSaleEndpoint(validInput);

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(sentBody.idempotencyKey).toBe(validInput.idempotencyKey);
    expect(sentBody.businessId).toBe(validInput.businessId);
    expect(sentBody.customerId).toBe(validInput.customerId);
  });

  it("non-200 response → throws PaymentLinkSaleWritebackError (hard stop)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const { callPaymentLinkSaleEndpoint, PaymentLinkSaleWritebackError } = await importHelper();
    await expect(callPaymentLinkSaleEndpoint(validInput)).rejects.toBeInstanceOf(
      PaymentLinkSaleWritebackError,
    );
  });

  it("503 from core → throws PaymentLinkSaleWritebackError with status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const { callPaymentLinkSaleEndpoint, PaymentLinkSaleWritebackError } = await importHelper();
    const err = await callPaymentLinkSaleEndpoint(validInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentLinkSaleWritebackError);
    expect((err as InstanceType<typeof PaymentLinkSaleWritebackError>).status).toBe(503);
  });

  it("network error → throws PaymentLinkSaleWritebackError (no silent success)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { callPaymentLinkSaleEndpoint, PaymentLinkSaleWritebackError } = await importHelper();
    await expect(callPaymentLinkSaleEndpoint(validInput)).rejects.toBeInstanceOf(
      PaymentLinkSaleWritebackError,
    );
  });
});

// ── Section 3: flag gate — isPaymentsOverHttpEnabled() ───────────────────────
// Tests isPaymentsOverHttpEnabled() directly from the writeback module,
// verifying that the env var is read at call time (not module-load).

describe("isPaymentsOverHttpEnabled", () => {
  const importHelper = () =>
    import(
      "@/app/api/agents/payments/jsonrpc/_lib/payment-link-sale-writeback"
    ) as Promise<
      typeof import("@/app/api/agents/payments/jsonrpc/_lib/payment-link-sale-writeback")
    >;

  afterEach(() => {
    delete process.env.PAYMENTS_OVER_HTTP_ENABLED;
  });

  it("returns false when env var is not set", async () => {
    delete process.env.PAYMENTS_OVER_HTTP_ENABLED;
    const { isPaymentsOverHttpEnabled } = await importHelper();
    expect(isPaymentsOverHttpEnabled()).toBe(false);
  });

  it("returns false when env var is explicitly 'false'", async () => {
    process.env.PAYMENTS_OVER_HTTP_ENABLED = "false";
    const { isPaymentsOverHttpEnabled } = await importHelper();
    expect(isPaymentsOverHttpEnabled()).toBe(false);
  });

  it("returns true when env var is 'true'", async () => {
    process.env.PAYMENTS_OVER_HTTP_ENABLED = "true";
    const { isPaymentsOverHttpEnabled } = await importHelper();
    expect(isPaymentsOverHttpEnabled()).toBe(true);
  });

  it("reads env at call time — toggling env changes behavior without re-import", async () => {
    delete process.env.PAYMENTS_OVER_HTTP_ENABLED;
    const { isPaymentsOverHttpEnabled } = await importHelper();
    expect(isPaymentsOverHttpEnabled()).toBe(false);
    process.env.PAYMENTS_OVER_HTTP_ENABLED = "true";
    expect(isPaymentsOverHttpEnabled()).toBe(true);
    delete process.env.PAYMENTS_OVER_HTTP_ENABLED;
    expect(isPaymentsOverHttpEnabled()).toBe(false);
  });
});
