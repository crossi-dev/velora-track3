// TDD (RED → GREEN → REFACTOR): CAE persist wiring — Package 2, Task T2.
//
// Verifies that persistCaeAndQr delegates DB write to InvoiceRepositoryPort.persistCaeFields
// (not inline prisma.invoice.update), threads businessId for tenant isolation, emits the
// INVOICE_CAE_PERSISTED success INFO log when persisted=true, and stays fail-soft.
//
// Spec: sdd/velora-core-api-cleanup/tasks — Task T2.
// Constraint: port does NOT emit the success log — caller (persistCaeAndQr) must emit it.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { cloudLogMock, persistCaeMock } = vi.hoisted(() => ({
  cloudLogMock: vi.fn(),
  persistCaeMock: vi.fn(),
}));

vi.mock("@/lib/cloud-logger", () => ({ cloudLog: cloudLogMock }));

// Mock the prismaInvoiceRepository singleton so we can assert port wiring
vi.mock("@/infrastructure/persistence/prisma-invoice.repository", () => ({
  prismaInvoiceRepository: {
    persistCaeFields: persistCaeMock,
  },
}));

// buildAfipQrUrl is a pure function — let it run naturally (no QR assertion needed here).
// It depends on nothing external (no prisma, no network).

import { persistCaeAndQr } from "@/app/api/agents/fiscal/jsonrpc/_lib/emit-invoice-tool.cae-persist";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BIZ_ID = "biz_test_001";
const INV_ID = "inv_test_001";

/** Minimal non-sandbox EmitResult to trigger the QR + persist path. */
const fakeRealRaw = {
  sandbox: false as const,
  cae: "75999000000012",
  vencimientoCae: "20260615",
  tipoComprobante: 6 as 6, // B — TipoComprobante literal
  puntoVenta: 1,
  numero: 42,
  issuedAt: "2026-06-01T10:00:00Z",
};

const baseInput = {
  businessId: BIZ_ID,
  invoiceId: INV_ID,
  businessCuit: "20123456789",
  invoiceDate: "2026-06-01",
  customerCuit: "30987654321",
  amountARS: 1000,
  raw: fakeRealRaw,
  resultCae: "75999000000012",
  resultNumero: 42,
  resultTipo: "B",
  resultVencimiento: "20260615",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("persistCaeAndQr — port wiring (T2)", () => {
  beforeEach(() => {
    cloudLogMock.mockReset();
    persistCaeMock.mockReset();
  });

  it("calls InvoiceRepositoryPort.persistCaeFields — NOT prisma.invoice.update", async () => {
    persistCaeMock.mockResolvedValue({ persisted: true });

    await persistCaeAndQr(baseInput);

    expect(persistCaeMock).toHaveBeenCalledTimes(1);
  });

  it("threads businessId into persistCaeFields for tenant isolation", async () => {
    persistCaeMock.mockResolvedValue({ persisted: true });

    await persistCaeAndQr(baseInput);

    expect(persistCaeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ_ID,
        invoiceId: INV_ID,
        caeCode: "75999000000012",
        fiscalNumero: 42,
      }),
    );
  });

  it("emits INVOICE_CAE_PERSISTED INFO log when persisted=true (caller owns success log)", async () => {
    persistCaeMock.mockResolvedValue({ persisted: true });

    await persistCaeAndQr(baseInput);

    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "INFO",
        action: "INVOICE_CAE_PERSISTED",
      }),
    );
  });

  it("does NOT emit INVOICE_CAE_PERSISTED when persisted=false (no-match)", async () => {
    persistCaeMock.mockResolvedValue({ persisted: false });

    await persistCaeAndQr(baseInput);

    const infoCalls = cloudLogMock.mock.calls.filter(
      ([arg]) => arg?.severity === "INFO" && arg?.action === "INVOICE_CAE_PERSISTED",
    );
    expect(infoCalls).toHaveLength(0);
  });

  it("is fail-soft: does not throw even if persistCaeFields rejects", async () => {
    // The port already catches and returns { persisted: false } — but even if the
    // port somehow throws, persistCaeAndQr must absorb it.
    persistCaeMock.mockRejectedValue(new Error("unexpected port error"));

    await expect(persistCaeAndQr(baseInput)).resolves.toBeUndefined();
  });

  it("success log carries invoiceId, cae, fiscalNumero, tipo", async () => {
    persistCaeMock.mockResolvedValue({ persisted: true });

    await persistCaeAndQr(baseInput);

    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "INFO",
        action: "INVOICE_CAE_PERSISTED",
        data: expect.objectContaining({
          invoiceId: INV_ID,
          cae: "75999000000012",
          fiscalNumero: 42,
          tipo: "B",
        }),
      }),
    );
  });

  it("fails LOUD (ERROR) and skips the port when businessId is missing — never silently drops the CAE", async () => {
    // JD finding: a "" businessId would match 0 rows and silently drop the CAE
    // while AFIP considers it emitted. Guard must log ERROR and NOT call the port.
    await persistCaeAndQr({ ...baseInput, businessId: "" });

    expect(persistCaeMock).not.toHaveBeenCalled();
    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "ERROR",
        action: "INVOICE_CAE_PERSIST_NO_BUSINESS_ID",
      }),
    );
  });
});
