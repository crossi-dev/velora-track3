// TDD RED → GREEN: MercadoPago official SDK client swap
// Verifies behavior-preservation of createMpPreference and getMpPaymentStatusByPreference
// after replacing hand-rolled fetch + mpFetchWithRetry with the official SDK.
//
// MONEY PATH — these tests are the safety net. Return shapes must be IDENTICAL to
// the pre-SDK implementation so mp-adapter.ts callers are unaffected.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── SDK mock ─────────────────────────────────────────────────────────────────
// We mock the mercadopago module so tests run without real HTTP. The SDK's
// Preference and Payment classes are the units under test — we replace their
// internal fetch so we can control success / error shapes.

vi.mock("mercadopago", () => {
  const mockPreferenceCreate = vi.fn();
  const mockPaymentSearch = vi.fn();

  class MockMercadoPagoConfig {
    constructor(public config: { accessToken: string }) {}
  }

  class MockPreference {
    constructor(_config: MockMercadoPagoConfig) {}
    create = mockPreferenceCreate;
  }

  class MockPayment {
    constructor(_config: MockMercadoPagoConfig) {}
    search = mockPaymentSearch;
  }

  return {
    MercadoPagoConfig: MockMercadoPagoConfig,
    Preference: MockPreference,
    Payment: MockPayment,
    __mocks: { mockPreferenceCreate, mockPaymentSearch },
  };
});

// ── Dependency mocks ─────────────────────────────────────────────────────────
vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: vi.fn().mockResolvedValue({ name: "Test Shop" }) },
  },
}));
vi.mock("@/lib/cloud-logger", () => ({ cloudLog: vi.fn() }));
vi.mock("@velora/core-utils/mp-token-cipher", () => ({ decrypt: vi.fn() }));
vi.mock("@/app/api/integrations/mp/_lib/config", () => ({
  getMpConfig: vi.fn().mockReturnValue({ isConfigured: false }),
}));
vi.mock("@/app/api/integrations/mp/_lib/refresh-token", () => ({
  getValidAccessToken: vi.fn(),
}));
vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/mp-preference-sale-items",
  () => ({
    buildMpItems: vi.fn().mockReturnValue([
      { title: "Test item", quantity: 1, unit_price: 1000, currency_id: "ARS" },
    ]),
  }),
);

// Import after mocks are in place.
import {
  createMpPreference,
  getMpPaymentStatusByPreference,
} from "@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getMockFns() {
  // Access the mock fns injected via __mocks in the mock factory.
  const mp = await import("mercadopago");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test internal
  const mocks = (mp as any).__mocks as {
    mockPreferenceCreate: ReturnType<typeof vi.fn>;
    mockPaymentSearch: ReturnType<typeof vi.fn>;
  };
  return mocks;
}

const BASE_PARAMS = {
  accessToken: "APP_USR-test-token",
  amountARS: 10_000,
  description: "Venta Velora test",
  customerName: "Ana Test",
  businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
  externalReference: "biz1aaaaaaaaaaaaaaaaaaaa:pi1aaaaaa",
  prefetchedBusinessName: "Test Shop",
};

// ─────────────────────────────────────────────────────────────────────────────
// createMpPreference — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("createMpPreference (SDK-backed)", () => {
  beforeEach(async () => {
    const { mockPreferenceCreate } = await getMockFns();
    mockPreferenceCreate.mockReset();
  });

  it("returns { preferenceId, checkoutUrl } on SDK success", async () => {
    const { mockPreferenceCreate } = await getMockFns();
    // SDK success shape: parsed JSON body + api_response appended by RestClient
    mockPreferenceCreate.mockResolvedValueOnce({
      id: "pref-abc-123",
      init_point: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-abc-123",
      api_response: { status: 201, headers: {} },
    });

    const result = await createMpPreference(BASE_PARAMS);

    expect(result).toEqual({
      preferenceId: "pref-abc-123",
      checkoutUrl: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-abc-123",
    });
    expect(mockPreferenceCreate).toHaveBeenCalledOnce();
  });

  it("returns { error: 'mp_api_error', detail } on SDK throw (non-2xx)", async () => {
    // SDK throws the parsed JSON body on non-2xx (from RestClient: throw await response.json())
    const { mockPreferenceCreate } = await getMockFns();
    mockPreferenceCreate.mockRejectedValueOnce({
      status: 400,
      message: "bad_request",
      error: "bad_request",
    });

    const result = await createMpPreference(BASE_PARAMS);

    expect(result).toMatchObject({ error: "mp_api_error" });
    // detail must be present and truthy
    expect((result as { error: string; detail: unknown }).detail).toBeTruthy();
  });

  it("returns { error: 'bad_shape' } when SDK returns no id or init_point", async () => {
    const { mockPreferenceCreate } = await getMockFns();
    mockPreferenceCreate.mockResolvedValueOnce({
      // id and init_point are missing — malformed response
      api_response: { status: 201, headers: {} },
    });

    const result = await createMpPreference(BASE_PARAMS);

    expect(result).toMatchObject({ error: "bad_shape" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getMpPaymentStatusByPreference — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("getMpPaymentStatusByPreference (SDK-backed)", () => {
  beforeEach(async () => {
    const { mockPaymentSearch } = await getMockFns();
    mockPaymentSearch.mockReset();
  });

  it("returns { status: 'approved', paymentId, detail } on found approved payment", async () => {
    const { mockPaymentSearch } = await getMockFns();
    // SDK Payment.search success: { results: [...], paging: {...}, api_response: {...} }
    mockPaymentSearch.mockResolvedValueOnce({
      results: [{ id: 987654, status: "approved", external_reference: "biz1:pi1" }],
      paging: { total: 1, limit: 1, offset: 0 },
      api_response: { status: 200, headers: {} },
    });

    const result = await getMpPaymentStatusByPreference({
      accessToken: "APP_USR-test-token",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      paymentIntentId: "pi1aaaaaa",
    });

    expect(result.status).toBe("approved");
    expect(result.paymentId).toBe("987654");
    expect(result.detail).toBeTruthy();
  });

  it("returns { status: 'pending', paymentId: null } when results array is empty", async () => {
    const { mockPaymentSearch } = await getMockFns();
    mockPaymentSearch.mockResolvedValueOnce({
      results: [],
      paging: { total: 0, limit: 1, offset: 0 },
      api_response: { status: 200, headers: {} },
    });

    const result = await getMpPaymentStatusByPreference({
      accessToken: "APP_USR-test-token",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      paymentIntentId: "pi1aaaaaa",
    });

    expect(result.status).toBe("pending");
    expect(result.paymentId).toBeNull();
  });

  it("returns { status: 'rejected' } when payment status is 'rejected'", async () => {
    const { mockPaymentSearch } = await getMockFns();
    mockPaymentSearch.mockResolvedValueOnce({
      results: [{ id: 111, status: "rejected" }],
      paging: { total: 1, limit: 1, offset: 0 },
      api_response: { status: 200, headers: {} },
    });

    const result = await getMpPaymentStatusByPreference({
      accessToken: "APP_USR-test-token",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      paymentIntentId: "pi1aaaaaa",
    });

    expect(result.status).toBe("rejected");
    expect(result.paymentId).toBe("111");
  });

  it("returns { status: 'rejected', paymentId: null } when SDK throws (search error)", async () => {
    const { mockPaymentSearch } = await getMockFns();
    // SDK throws on non-2xx
    mockPaymentSearch.mockRejectedValueOnce({ status: 400, message: "bad_request" });

    const result = await getMpPaymentStatusByPreference({
      accessToken: "APP_USR-test-token",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      paymentIntentId: "pi1aaaaaa",
    });

    expect(result.status).toBe("rejected");
    expect(result.paymentId).toBeNull();
    // detail must document the error
    expect(result.detail).toBeTruthy();
  });

  it("surfaces httpStatus in detail when SDK throws a non-retryable error", async () => {
    const { mockPaymentSearch } = await getMockFns();
    // SDK throws the parsed JSON body — status field mirrors the HTTP status code.
    // Use 401 (non-retryable 4xx) so mpSdkWithRetry surfaces it immediately.
    mockPaymentSearch.mockRejectedValueOnce({ status: 401, message: "unauthorized", error: "unauthorized" });

    const result = await getMpPaymentStatusByPreference({
      accessToken: "APP_USR-test-token",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      paymentIntentId: "pi1aaaaaa",
    });

    expect(result.status).toBe("rejected");
    expect((result.detail as Record<string, unknown>).httpStatus).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 429 retry — regression guard for the SDK adoption
// ─────────────────────────────────────────────────────────────────────────────
// The official SDK v3 only retries HTTP 5xx (not 429). mpSdkWithRetry wraps the
// SDK call to restore the prior mpFetchWithRetry behavior. These tests confirm
// that the wrapper retries on 429 and succeeds on the next attempt.
//
// Fake timers are used so the jitter sleep resolves instantly without real waits.

describe("mpSdkWithRetry — 429 retry behavior", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { mockPreferenceCreate, mockPaymentSearch } = await getMockFns();
    mockPreferenceCreate.mockReset();
    mockPaymentSearch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createMpPreference retries on 429 and succeeds on second attempt", async () => {
    const { mockPreferenceCreate } = await getMockFns();
    // First call: SDK throws a 429 error body (same shape as RestClient throw)
    mockPreferenceCreate
      .mockRejectedValueOnce({ status: 429, message: "Too Many Requests", error: "too_many_requests" })
      .mockResolvedValueOnce({
        id: "pref-retry-ok",
        init_point: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-retry-ok",
        api_response: { status: 201, headers: {} },
      });

    // Run the call and advance fake timers to skip jitter sleep
    const resultPromise = createMpPreference(BASE_PARAMS);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({
      preferenceId: "pref-retry-ok",
      checkoutUrl: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-retry-ok",
    });
    // SDK was called twice: first 429, then success
    expect(mockPreferenceCreate).toHaveBeenCalledTimes(2);
  });

  it("createMpPreference gives up and returns error after 3 consecutive 429s", async () => {
    const { mockPreferenceCreate } = await getMockFns();
    const err429 = { status: 429, message: "Too Many Requests", error: "too_many_requests" };
    mockPreferenceCreate
      .mockRejectedValueOnce(err429)
      .mockRejectedValueOnce(err429)
      .mockRejectedValueOnce(err429);

    const resultPromise = createMpPreference(BASE_PARAMS);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({ error: "mp_api_error" });
    expect(mockPreferenceCreate).toHaveBeenCalledTimes(3);
  });

  it("getMpPaymentStatusByPreference retries on 429 and succeeds on second attempt", async () => {
    const { mockPaymentSearch } = await getMockFns();
    mockPaymentSearch
      .mockRejectedValueOnce({ status: 429, message: "Too Many Requests", error: "too_many_requests" })
      .mockResolvedValueOnce({
        results: [{ id: 777, status: "approved" }],
        paging: { total: 1, limit: 1, offset: 0 },
        api_response: { status: 200, headers: {} },
      });

    const resultPromise = getMpPaymentStatusByPreference({
      accessToken: "APP_USR-test-token",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      paymentIntentId: "pi1aaaaaa",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("approved");
    expect(result.paymentId).toBe("777");
    expect(mockPaymentSearch).toHaveBeenCalledTimes(2);
  });

  // Defect 1 regression: persistent 5xx must result in exactly MP_RETRY_MAX_ATTEMPTS (3)
  // SDK calls — not 6-9 (3 outer × 2 SDK internal). With retries: 1 in requestOptions,
  // the SDK fires exactly 1 HTTP call per outer attempt, so total = 3.
  it("createMpPreference on persistent 5xx calls SDK exactly 3 times (no SDK internal retry)", async () => {
    const { mockPreferenceCreate } = await getMockFns();
    const err503 = { status: 503, message: "Service Unavailable", error: "service_unavailable" };
    mockPreferenceCreate
      .mockRejectedValueOnce(err503)
      .mockRejectedValueOnce(err503)
      .mockRejectedValueOnce(err503);

    const resultPromise = createMpPreference(BASE_PARAMS);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // Outer wrapper exhausts 3 attempts and surfaces mp_api_error
    expect(result).toMatchObject({ error: "mp_api_error" });
    // SDK mock must have been called exactly 3 times — not 6 or 9
    expect(mockPreferenceCreate).toHaveBeenCalledTimes(3);
  });
});
