// tests/vitest/mcp/agent-payments-status-seam.test.ts
//
// Tests for the PaymentsBackend.getPaymentStatus seam in buildGetPaymentStatusTool.
// Verifies that the tool delegates to createPaymentsBackend().getPaymentStatus and
// maps the port output back to the tool's exact return shape.
//
// Mock seam: @/lib/mcp/_lib/payments-backend.factory → createPaymentsBackend
//
// Coverage:
//   1. Happy path by paymentIntentId → returns success shape with all fields.
//   2. Happy path by customerName → backend resolves and returns success shape.
//   3. missing_business_context guard → early return before backend is called.
//   4. domainError missing_lookup_key → { error, message, currency }.
//   5. domainError customer_not_found → { error, message, currency }.
//   6. domainError no_payment_intent_found (customerName path) → { error, message, currency }.
//   7. domainError payment_intent_not_found (ownership pre-check in adapter) → { error: "no_payment_intent_found", … }.
//   8. domainError status_lookup_failed → { error, paymentIntentId, currency }.
//   9. createPaymentsBackend is called — NOT getPaymentProvider directly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PaymentsBackend } from "@/lib/mcp/_lib/payments-backend.port";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { createPaymentsBackendMock } = vi.hoisted(() => ({
  createPaymentsBackendMock: vi.fn(),
}));

vi.mock("@/lib/mcp/_lib/payments-backend.factory", () => ({
  createPaymentsBackend: createPaymentsBackendMock,
}));

// ── Subject ───────────────────────────────────────────────────────────────────

// Import AFTER mocks.
// eslint-disable-next-line import/order
import { buildGetPaymentStatusTool } from "@/app/api/agents/payments/jsonrpc/_lib/payments-status-tool";

// ── Types ─────────────────────────────────────────────────name──────────────────

type ToolReturn = Record<string, unknown>;

/** Execute the FunctionTool's handler directly via its internal execute callback. */
async function executeToolWith(
  businessId: string | null,
  input: { paymentIntentId?: string; customerName?: string },
): Promise<ToolReturn> {
  const tool = buildGetPaymentStatusTool({
    businessId,
    actorUserId: "actor-test",
    turnId: "turn-test",
    bizSnapshot: null,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test: invoke internal execute directly
  return (tool as any).execute(input) as Promise<ToolReturn>;
}

/** Minimal PaymentsBackend stub — only getPaymentStatus needed for these tests. */
function makeBackendStub(
  getPaymentStatusResult: Awaited<ReturnType<PaymentsBackend["getPaymentStatus"]>>,
): PaymentsBackend {
  return {
    createPreference: vi.fn(),
    getMpPaymentStatus: vi.fn(),
    getPaymentStatus: vi.fn().mockResolvedValue(getPaymentStatusResult),
  } as unknown as PaymentsBackend;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("get_payment_status tool — PaymentsBackend seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Happy path by paymentIntentId ─────────────────────────────────────────

  it("returns full success shape when backend resolves by paymentIntentId", async () => {
    const stub = makeBackendStub({
      paymentIntentId: "pi-001",
      status: "approved",
      providerRef: "mp-ref-abc",
    });
    createPaymentsBackendMock.mockReturnValue(stub);

    const result = await executeToolWith("biz-001", { paymentIntentId: "pi-001" });

    expect(result).toEqual({
      sandbox: false,
      paymentIntentId: "pi-001",
      customerName: null,
      providerRef: "mp-ref-abc",
      status: "approved",
      currency: "ARS",
    });
    expect(stub.getPaymentStatus).toHaveBeenCalledWith({
      tenantId: "biz-001",
      paymentIntentId: "pi-001",
      customerName: undefined,
    });
  });

  // ── 2. Happy path by customerName ────────────────────────────────────────────

  it("returns success shape when backend resolves by customerName", async () => {
    const stub = makeBackendStub({
      paymentIntentId: "pi-by-name-001",
      status: "pending",
      providerRef: null,
    });
    createPaymentsBackendMock.mockReturnValue(stub);

    const result = await executeToolWith("biz-002", { customerName: "María García" });

    expect(result).toEqual({
      sandbox: false,
      paymentIntentId: "pi-by-name-001",
      customerName: "María García",
      providerRef: null,
      status: "pending",
      currency: "ARS",
    });
    expect(stub.getPaymentStatus).toHaveBeenCalledWith({
      tenantId: "biz-002",
      paymentIntentId: undefined,
      customerName: "María García",
    });
  });

  // ── 3. missing_business_context guard ────────────────────────────────────────

  it("returns missing_business_context error and does NOT call backend when businessId is null", async () => {
    const stub = makeBackendStub({ paymentIntentId: "pi-001", status: "approved" });
    createPaymentsBackendMock.mockReturnValue(stub);

    const result = await executeToolWith(null, { paymentIntentId: "pi-001" });

    expect(result).toEqual({ error: "missing_business_context", currency: "ARS" });
    expect(stub.getPaymentStatus).not.toHaveBeenCalled();
  });

  // ── 4. domainError: missing_lookup_key ───────────────────────────────────────

  it("returns missing_lookup_key shape when backend returns that domainError", async () => {
    const stub = makeBackendStub({
      domainError: "missing_lookup_key",
      errorMessage: "Provide paymentIntentId or customerName.",
    });
    createPaymentsBackendMock.mockReturnValue(stub);

    const result = await executeToolWith("biz-003", {});

    expect(result.error).toBe("missing_lookup_key");
    expect(typeof result.message).toBe("string");
    expect(result.currency).toBe("ARS");
    expect(result.sandbox).toBeUndefined();
    expect(result.status).toBeUndefined();
  });

  // ── 5. domainError: customer_not_found ───────────────────────────────────────

  it("returns customer_not_found shape with interpolated customerName in message", async () => {
    const stub = makeBackendStub({
      domainError: "customer_not_found",
      errorMessage: 'No se encontró al cliente "Cliente Fantasma".',
    });
    createPaymentsBackendMock.mockReturnValue(stub);

    const result = await executeToolWith("biz-004", { customerName: "Cliente Fantasma" });

    expect(result.error).toBe("customer_not_found");
    expect(result.currency).toBe("ARS");
    expect(String(result.message)).toContain("Cliente Fantasma");
  });

  // ── 6. domainError: no_payment_intent_found (customerName path) ──────────────

  it("returns no_payment_intent_found shape when customer has no intents", async () => {
    const stub = makeBackendStub({
      domainError: "no_payment_intent_found",
      errorMessage: 'No se encontró ningún cobro para "Ana López".',
    });
    createPaymentsBackendMock.mockReturnValue(stub);

    const result = await executeToolWith("biz-005", { customerName: "Ana López" });

    expect(result.error).toBe("no_payment_intent_found");
    expect(result.currency).toBe("ARS");
    expect(String(result.message)).toContain("Ana López");
  });

  // ── 7. domainError: payment_intent_not_found (ownership pre-check) ───────────

  it("maps payment_intent_not_found → error: no_payment_intent_found (tool compat shape)", async () => {
    const stub = makeBackendStub({
      domainError: "payment_intent_not_found",
      errorMessage: "No se encontró el cobro.",
    });
    createPaymentsBackendMock.mockReturnValue(stub);

    const result = await executeToolWith("biz-006", { paymentIntentId: "pi-foreign-999" });

    // The tool merges both "not found" error codes into "no_payment_intent_found"
    // to keep the return shape stable vs the original inline code.
    expect(result.error).toBe("no_payment_intent_found");
    expect(result.currency).toBe("ARS");
  });

  // ── 8. domainError: status_lookup_failed ─────────────────────────────────────

  it("returns status_lookup_failed shape with paymentIntentId", async () => {
    const stub = makeBackendStub({
      domainError: "status_lookup_failed",
      errorMessage: "Provider unavailable",
      paymentIntentId: "pi-err-001",
    });
    createPaymentsBackendMock.mockReturnValue(stub);

    const result = await executeToolWith("biz-007", { paymentIntentId: "pi-err-001" });

    expect(result.error).toBe("status_lookup_failed");
    expect(result.paymentIntentId).toBe("pi-err-001");
    expect(result.currency).toBe("ARS");
    expect(result.status).toBeUndefined();
    expect(result.sandbox).toBeUndefined();
  });

  // ── 9. createPaymentsBackend is called, NOT getPaymentProvider directly ───────

  it("calls createPaymentsBackend (not getPaymentProvider) for delegation", async () => {
    const stub = makeBackendStub({ paymentIntentId: "pi-seam-001", status: "approved" });
    createPaymentsBackendMock.mockReturnValue(stub);

    await executeToolWith("biz-seam", { paymentIntentId: "pi-seam-001" });

    expect(createPaymentsBackendMock).toHaveBeenCalledOnce();
    // createPaymentsBackend is called without a tenantOverride (uses env default "velora")
    expect(createPaymentsBackendMock).toHaveBeenCalledWith();
  });
});
