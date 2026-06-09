// TDD — payment-link wizard expiry threading (T-2 + T-3-chain-a).
//
// MONEY PATH. Verifies that `expiresInDays` flows ONLY through the adapter layer:
//   createMpPreference  → injects body.date_of_expiration (MP "after which the
//                         preference cannot be paid" — SDK PreferenceRequest type).
//   MercadoPagoAdapter.createCollection → forwards expiresInDays to createMpPreference.
//
// The use-case / transaction layer is intentionally NOT involved (C-1): the DB
// PaymentIntent.expiresAt stays at now+60min; the 3-day MP preference lives
// independently. See payment-link-wizard ledger.
//
// Field source of truth: node_modules/mercadopago PreferenceRequest.date_of_expiration
// — "ISO 8601 expiration date after which the preference cannot be paid."

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── SDK mock — capture the preference body passed to preference.create() ───────
vi.mock("mercadopago", () => {
  const mockPreferenceCreate = vi.fn();
  class MockMercadoPagoConfig {
    constructor(public config: { accessToken: string }) {}
  }
  class MockPreference {
    constructor(_config: MockMercadoPagoConfig) {}
    create = mockPreferenceCreate;
  }
  class MockPayment {
    constructor(_config: MockMercadoPagoConfig) {}
    search = vi.fn();
  }
  return {
    MercadoPagoConfig: MockMercadoPagoConfig,
    Preference: MockPreference,
    Payment: MockPayment,
    __mocks: { mockPreferenceCreate },
  };
});

// ── Dependency mocks ──────────────────────────────────────────────────────────
vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: vi.fn().mockResolvedValue({ name: "Test Shop" }) },
  },
}));
vi.mock("@/lib/cloud-logger", () => ({ cloudLog: vi.fn() }));
vi.mock("@velora/core-utils/mp-token-cipher", () => ({
  decrypt: vi.fn().mockReturnValue("APP_USR-decrypted-token"),
}));
// Adapter write-back target — patchCheckout must report a row updated.
vi.mock("@/infrastructure/persistence/prisma-payment-intent.repository", () => ({
  prismaPaymentIntentRepository: { patchCheckout: vi.fn().mockResolvedValue({ count: 1 }) },
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/mp-reconnect-nudge", () => ({
  nudgeMpReconnect: vi.fn(),
}));
vi.mock("@/app/api/integrations/mp/_lib/config", () => ({
  getMpConfig: vi.fn().mockReturnValue({ isConfigured: false }),
}));
vi.mock("@/app/api/integrations/mp/_lib/refresh-token", () => ({
  getValidAccessToken: vi.fn(),
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/mp-preference-sale-items", () => ({
  buildMpItems: vi.fn().mockReturnValue([
    { title: "Test item", quantity: 1, unit_price: 1000, currency_id: "ARS" },
  ]),
}));

import { createMpPreference } from "@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers";
import { MercadoPagoAdapter } from "@/app/api/agents/payments/jsonrpc/_lib/providers/mp-adapter";

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getCreateMock() {
  const mp = await import("mercadopago");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test internal
  return (mp as any).__mocks.mockPreferenceCreate as ReturnType<typeof vi.fn>;
}

function mockSdkSuccess(create: ReturnType<typeof vi.fn>) {
  create.mockResolvedValueOnce({
    id: "pref-exp-1",
    init_point: "https://mp.test/checkout?pref_id=pref-exp-1",
    api_response: { status: 201, headers: {} },
  });
}

const BASE = {
  accessToken: "APP_USR-test-token",
  amountARS: 10_000,
  description: "Venta Velora test",
  businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
  externalReference: "biz1aaaaaaaaaaaaaaaaaaaa:pi1aaaaaa",
  prefetchedBusinessName: "Test Shop",
};

const DAY_MS = 86_400_000;

// ── T-2: createMpPreference injects date_of_expiration ─────────────────────────

describe("createMpPreference — expiresInDays (T-2)", () => {
  beforeEach(async () => {
    (await getCreateMock()).mockReset();
  });

  it("Test A: with expiresInDays=3, body.date_of_expiration ≈ now + 3 days (ISO)", async () => {
    const create = await getCreateMock();
    mockSdkSuccess(create);

    const before = Date.now();
    await createMpPreference({ ...BASE, expiresInDays: 3 });
    const after = Date.now();

    const body = create.mock.calls[0][0].body;
    expect(typeof body.date_of_expiration).toBe("string");
    const exp = new Date(body.date_of_expiration).getTime();
    // Must land between (before+3d) and (after+3d) — exact, no tolerance slop needed.
    expect(exp).toBeGreaterThanOrEqual(before + 3 * DAY_MS);
    expect(exp).toBeLessThanOrEqual(after + 3 * DAY_MS);
  });

  it("Test B: without expiresInDays, body.date_of_expiration is absent (in-person path unchanged)", async () => {
    const create = await getCreateMock();
    mockSdkSuccess(create);

    await createMpPreference({ ...BASE });

    const body = create.mock.calls[0][0].body;
    expect(body.date_of_expiration).toBeUndefined();
  });
});

// ── T-3-chain-a: MercadoPagoAdapter.createCollection threads expiresInDays ──────
// Exercises the REAL adapter → createMpPreference path (not a mocked helper), so
// the wiring is proven end-to-end through the SDK mock's captured body.

describe("MercadoPagoAdapter.createCollection — expiresInDays (T-3-chain-a)", () => {
  const futureExpiry = new Date(Date.now() + 365 * DAY_MS);
  const mpConn = { accessTokenCiphertext: "ciphertext", expiresAt: futureExpiry, scope: "self-managed" };

  beforeEach(async () => {
    (await getCreateMock()).mockReset();
  });

  it("Test C: createCollection with expiresInDays=5 forwards it (body.date_of_expiration ≈ now + 5 days)", async () => {
    const create = await getCreateMock();
    mockSdkSuccess(create);

    const before = Date.now();
    const res = await new MercadoPagoAdapter().createCollection({
      paymentIntentId: "pi1aaaaaa",
      amountARS: 10_000,
      description: "Link remoto",
      businessId: BASE.businessId,
      prefetchedMpConnection: mpConn,
      expiresInDays: 5,
    });
    const after = Date.now();

    expect("error" in res).toBe(false);
    const body = create.mock.calls[0][0].body;
    const exp = new Date(body.date_of_expiration).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 5 * DAY_MS);
    expect(exp).toBeLessThanOrEqual(after + 5 * DAY_MS);
  });

  it("Test D: createCollection without expiresInDays → body.date_of_expiration absent", async () => {
    const create = await getCreateMock();
    mockSdkSuccess(create);

    await new MercadoPagoAdapter().createCollection({
      paymentIntentId: "pi1aaaaaa",
      amountARS: 10_000,
      description: "QR presencial",
      businessId: BASE.businessId,
      prefetchedMpConnection: mpConn,
    });

    const body = create.mock.calls[0][0].body;
    expect(body.date_of_expiration).toBeUndefined();
  });
});
