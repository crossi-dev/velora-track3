// tests/vitest/payments/crear-link-pago-execute-guards.test.ts
//
// Verifies the defense-in-depth input guards restored on the flag-ON execute path:
//
//   G1 — missing customerId returns { error: { code: "missing_customer_id" } }
//        and does NOT hit the use-case / DB.
//
//   G2 — empty items array returns { error: { code: "missing_items" } }
//        and does NOT hit the use-case / DB.
//
//   G3 — null items returns { error: { code: "missing_items" } }.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Suppress server-only ────────────────────────────────────────────────────────
vi.mock("server-only", () => ({}));

// ── Hoist mocks so they are available before module imports ─────────────────────
const {
  registerSaleWithPaymentLinkUseCaseMock,
  callPaymentLinkSaleEndpointMock,
  isPaymentsOverHttpEnabledMock,
  prismaBusinessFindUniqueMock,
  getMissingBusinessDataMock,
} = vi.hoisted(() => ({
  registerSaleWithPaymentLinkUseCaseMock: vi.fn(),
  callPaymentLinkSaleEndpointMock: vi.fn(),
  isPaymentsOverHttpEnabledMock: vi.fn().mockReturnValue(false),
  prismaBusinessFindUniqueMock: vi.fn(),
  getMissingBusinessDataMock: vi.fn(),
}));

vi.mock(
  "@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case",
  () => ({ registerSaleWithPaymentLinkUseCase: registerSaleWithPaymentLinkUseCaseMock }),
);

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/payment-link-sale-writeback",
  () => ({
    callPaymentLinkSaleEndpoint: callPaymentLinkSaleEndpointMock,
    isPaymentsOverHttpEnabled: isPaymentsOverHttpEnabledMock,
  }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: { business: { findUnique: prismaBusinessFindUniqueMock }, customer: { findUnique: vi.fn() }, paymentIntent: { findUnique: vi.fn() } },
}));

vi.mock("@velora/core-utils/missing-business-data", () => ({
  getMissingBusinessData: getMissingBusinessDataMock,
}));

vi.mock("@/lib/cloud-logger", () => ({
  cloudLog: vi.fn(),
  reportError: vi.fn(),
  runWithTraceContext: vi.fn((_, fn: () => unknown) => fn()),
}));

// Stub remaining dependencies that the module imports at the top
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/payment-provider", () => ({
  getPaymentProvider: vi.fn(),
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/shipping-quote", () => ({
  resolveShippingQuote: vi.fn(),
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/payment-link-orphan-heal", () => ({
  healOrphanedIntent: vi.fn(),
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/adk-payments-agent", () => ({
  buildLinkIdempotencyKey: vi.fn().mockReturnValue("idem-key-1"),
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/mp-preference-sale-items", () => ({
  resolveSaleItemsForPreference: vi.fn(),
}));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/payments-agent-tools.outcome-map", () => ({
  mapRegisterSaleOutcomeToError: vi.fn().mockReturnValue(null),
}));

// ── Import the SUT after all mocks are declared ─────────────────────────────────
import { executeCrearLinkPago } from "@/app/api/agents/payments/jsonrpc/_lib/pagos-crear-link-pago.execute";
import type { PaymentToolCtx } from "@/app/api/agents/payments/jsonrpc/_lib/payments-agent-types";

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PaymentToolCtx> = {}): PaymentToolCtx {
  return {
    businessId: "biz-123",
    actorUserId: "user-456",
    turnId: "turn-1",
    bizSnapshot: null,
    ...overrides,
  } as unknown as PaymentToolCtx;
}

const validItems = [{ productId: "prod-1", quantity: 1 }];

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("executeCrearLinkPago — input guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure the use-case is never called in guard tests
    registerSaleWithPaymentLinkUseCaseMock.mockResolvedValue(undefined);
    callPaymentLinkSaleEndpointMock.mockResolvedValue(undefined);
    // getMissingBusinessData must not block if we somehow reach it
    getMissingBusinessDataMock.mockReturnValue({ paymentLinks: { blocked: false } });
    prismaBusinessFindUniqueMock.mockResolvedValue({
      postalCode: "5500", paymentProvider: "mp", alias: "test.alias",
      whatsappPhone: "+54911", cuit: "20123456789", courierPreference: null,
    });
  });

  it("G1 — missing customerId (empty string) returns missing_customer_id without hitting use-case", async () => {
    const result = await executeCrearLinkPago(
      { customerId: "", items: validItems, description: "test" },
      makeCtx(),
    );

    expect(result).toMatchObject({ error: { code: "missing_customer_id" } });
    expect(result).toHaveProperty("error.message");
    // Use-case must NOT have been called
    expect(registerSaleWithPaymentLinkUseCaseMock).not.toHaveBeenCalled();
    expect(callPaymentLinkSaleEndpointMock).not.toHaveBeenCalled();
  });

  it("G1 — missing customerId (undefined coerced) returns missing_customer_id", async () => {
    const result = await executeCrearLinkPago(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: simulating LLM omitting field
      { customerId: undefined as any, items: validItems, description: "test" },
      makeCtx(),
    );

    expect(result).toMatchObject({ error: { code: "missing_customer_id" } });
    expect(registerSaleWithPaymentLinkUseCaseMock).not.toHaveBeenCalled();
  });

  it("G2 — empty items array returns missing_items without hitting use-case", async () => {
    const result = await executeCrearLinkPago(
      { customerId: "cust-1", items: [], description: "test" },
      makeCtx(),
    );

    expect(result).toMatchObject({ error: { code: "missing_items" } });
    expect(result).toHaveProperty("error.message");
    expect(registerSaleWithPaymentLinkUseCaseMock).not.toHaveBeenCalled();
    expect(callPaymentLinkSaleEndpointMock).not.toHaveBeenCalled();
  });

  it("G3 — null items returns missing_items", async () => {
    const result = await executeCrearLinkPago(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: simulating LLM sending null
      { customerId: "cust-1", items: null as any, description: "test" },
      makeCtx(),
    );

    expect(result).toMatchObject({ error: { code: "missing_items" } });
    expect(registerSaleWithPaymentLinkUseCaseMock).not.toHaveBeenCalled();
  });

  it("error message matches the old tool Spanish copy for missing_customer_id", async () => {
    const result = await executeCrearLinkPago(
      { customerId: "", items: validItems, description: "test" },
      makeCtx(),
    );
    expect((result as { error: { message: string } }).error.message).toContain(
      "El Supervisor debe resolver el ID del cliente",
    );
  });

  it("error message matches the old tool Spanish copy for missing_items", async () => {
    const result = await executeCrearLinkPago(
      { customerId: "cust-1", items: [], description: "test" },
      makeCtx(),
    );
    expect((result as { error: { message: string } }).error.message).toContain(
      "Incluí al menos un producto",
    );
  });
});
