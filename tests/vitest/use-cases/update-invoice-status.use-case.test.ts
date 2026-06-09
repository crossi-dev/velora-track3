import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateInvoiceStatusUseCase } from "@/application/use-cases/update-invoice-status.use-case";
import type { InvoiceRepositoryPort, InvoiceStatusRecord } from "@/domain/ports/invoice.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const fakeUpdated: InvoiceStatusRecord = { id: "inv1", status: "paid", invoiceNumber: "FC-0001" };

const mockInvoice: InvoiceRepositoryPort = {
  list: vi.fn(),
  findDetail: vi.fn(),
  findForStatusUpdate: vi.fn(),
  updateStatusInTransaction: vi.fn().mockResolvedValue(fakeUpdated),
  persistCaeFields: vi.fn().mockResolvedValue({ persisted: true }),
};

const mockIdempotency: IdempotencyPort = {
  begin: vi.fn(),
  complete: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
};

const mockAudit: AuditPort = {
  recordCriticalWrite: vi.fn().mockResolvedValue(true),
};

const mockTransaction: TransactionPort = {
  run: vi.fn(async (work) => work(mockTx)),
};

const ports = { invoice: mockInvoice, idempotency: mockIdempotency, audit: mockAudit, transaction: mockTransaction };
const useCase = updateInvoiceStatusUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  invoiceId: "inv1",
  newStatus: "paid",
  idempotencyKey: "key-inv",
  requestBody: {},
  actionMeta: { actionType: "invoice.update-status", routeScope: "invoices", resourceType: "Invoice" },
};

const issuedInvoice = { id: "inv1", status: "issued", businessId: "biz1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockInvoice.updateStatusInTransaction).mockResolvedValue(fakeUpdated);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("updateInvoiceStatusUseCase", () => {
  it("returns not_found when invoice missing", async () => {
    vi.mocked(mockInvoice.findForStatusUpdate).mockResolvedValue(null);
    expect((await useCase.execute(baseInput)).outcome).toBe("not_found");
  });

  it("returns paid_downgrade when trying to set paid invoice to issued", async () => {
    vi.mocked(mockInvoice.findForStatusUpdate).mockResolvedValue({ ...issuedInvoice, status: "paid" });
    const result = await useCase.execute({ ...baseInput, newStatus: "issued" });
    expect(result.outcome).toBe("paid_downgrade");
  });

  it("returns paid_downgrade when trying to set paid invoice to sent", async () => {
    vi.mocked(mockInvoice.findForStatusUpdate).mockResolvedValue({ ...issuedInvoice, status: "paid" });
    const result = await useCase.execute({ ...baseInput, newStatus: "sent" });
    expect(result.outcome).toBe("paid_downgrade");
  });

  it("returns sent_to_issued when sent invoice downgraded to issued", async () => {
    vi.mocked(mockInvoice.findForStatusUpdate).mockResolvedValue({ ...issuedInvoice, status: "sent" });
    const result = await useCase.execute({ ...baseInput, newStatus: "issued" });
    expect(result.outcome).toBe("sent_to_issued");
  });

  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockInvoice.findForStatusUpdate).mockResolvedValue(issuedInvoice);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { ok: true } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("updates status, completes idempotency, records audit", async () => {
    vi.mocked(mockInvoice.findForStatusUpdate).mockResolvedValue(issuedInvoice);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "updated", invoice: fakeUpdated });
    expect(mockInvoice.updateStatusInTransaction).toHaveBeenCalledWith(mockTx, { invoiceId: "inv1", businessId: "biz1", status: "paid" });
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 200, { invoice: fakeUpdated });
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: fakeUpdated.id })
    );
  });

  it("allows sent → paid transition", async () => {
    vi.mocked(mockInvoice.findForStatusUpdate).mockResolvedValue({ ...issuedInvoice, status: "sent" });
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });

    const result = await useCase.execute(baseInput);
    expect(result.outcome).toBe("updated");
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockInvoice.findForStatusUpdate).mockResolvedValue(issuedInvoice);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec3" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx failed"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx failed");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec3");
  });
});
