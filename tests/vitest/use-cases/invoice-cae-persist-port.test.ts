// TDD: InvoiceRepositoryPort.persistCaeFields — CAE write-back seam.
// Package 1, Invoice port extension — pure port/adapter, no wiring into callers.
// Verifies: id+businessId tenant scoping, null-field skip, and fail-soft (never throws).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateManyMock, cloudLogMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
  cloudLogMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { invoice: { updateMany: updateManyMock } },
}));
// Mock cloud-logger so the WARNING/ERROR paths don't pollute test output, and
// so we can assert the observability contract (the log IS the signal here).
vi.mock("@/lib/cloud-logger", () => ({ cloudLog: cloudLogMock }));

import { prismaInvoiceRepository } from "@/infrastructure/persistence/prisma-invoice.repository";

const baseArgs = {
  businessId: "biz_1",
  invoiceId: "inv_1",
  caeCode: "75123456789012",
  caeFchVto: new Date("2026-06-15T00:00:00Z"),
  fiscalTipo: 6,
  fiscalPtoVta: 1,
  fiscalNumero: 42,
  fiscalEmittedAt: new Date("2026-06-01T10:00:00Z"),
  fiscalQrUrl: "https://www.afip.gob.ar/fe/qr/?p=abc",
};

describe("prismaInvoiceRepository.persistCaeFields", () => {
  beforeEach(() => {
    updateManyMock.mockReset();
    cloudLogMock.mockReset();
  });

  it("writes CAE fields and returns { persisted: true } on success", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const result = await prismaInvoiceRepository.persistCaeFields(baseArgs);

    expect(result).toEqual({ persisted: true });
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caeCode: "75123456789012",
          fiscalNumero: 42,
        }),
      }),
    );
  });

  it("scopes the write by id AND businessId for tenant isolation", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    await prismaInvoiceRepository.persistCaeFields(baseArgs);

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inv_1", businessId: "biz_1" },
      }),
    );
  });

  it("skips null fields (passes undefined so they are left unchanged)", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    await prismaInvoiceRepository.persistCaeFields({
      ...baseArgs,
      caeFchVto: null,
      fiscalTipo: null,
      fiscalPtoVta: null,
      fiscalQrUrl: null,
    });

    const data = updateManyMock.mock.calls[0]?.[0]?.data;
    expect(data.caeFchVto).toBeUndefined();
    expect(data.fiscalTipo).toBeUndefined();
    expect(data.fiscalPtoVta).toBeUndefined();
    expect(data.fiscalQrUrl).toBeUndefined();
    // Required fields are still written.
    expect(data.caeCode).toBe("75123456789012");
  });

  it("returns { persisted: false } when no row matched (count: 0 — id/businessId mismatch)", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const result = await prismaInvoiceRepository.persistCaeFields(baseArgs);

    // A zero-row match must NOT be reported as success: the CAE was not written.
    expect(result).toEqual({ persisted: false });
    // ERROR (JD finding): on the fiscal path, CAE-emitted-but-not-stored is a legal-compliance gap.
    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "ERROR", action: "INVOICE_CAE_PERSIST_NO_MATCH" }),
    );
  });

  it("is fail-soft: returns { persisted: false } and does NOT throw when the DB write fails", async () => {
    updateManyMock.mockRejectedValue(new Error("connection reset"));

    const result = await prismaInvoiceRepository.persistCaeFields(baseArgs);

    expect(result).toEqual({ persisted: false });
    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "ERROR", action: "INVOICE_CAE_PERSIST_FAILED" }),
    );
  });
});
