import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupplierUseCase } from "@/application/use-cases/create-supplier.use-case";
import type { SupplierRepositoryPort, SupplierRecord } from "@/domain/ports/supplier.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const fakeSupplier: SupplierRecord = {
  id: "sup1", name: "Distribuidora SRL",
  phone: null, email: null, contactName: null, leadTimeDays: 0,
};

const mockSupplier: SupplierRepositoryPort = {
  findById: vi.fn(),
  createInTransaction: vi.fn().mockResolvedValue(fakeSupplier),
  updateInTransaction: vi.fn(),
  deleteInTransaction: vi.fn(),
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

const ports = { supplier: mockSupplier, idempotency: mockIdempotency, audit: mockAudit, transaction: mockTransaction };
const useCase = createSupplierUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  name: "Distribuidora SRL",
  idempotencyKey: "key-sup",
  requestBody: {},
  actionMeta: { actionType: "supplier.create", routeScope: "suppliers", resourceType: "Supplier" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockSupplier.createInTransaction).mockResolvedValue(fakeSupplier);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("createSupplierUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 201, body: { supplier: fakeSupplier } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("returns idempotency_in_flight when in flight", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "in_flight" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_in_flight");
  });

  it("creates supplier, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "created", supplier: fakeSupplier });
    expect(mockSupplier.createInTransaction).toHaveBeenCalledWith(
      mockTx, expect.objectContaining({ businessId: "biz1", name: "Distribuidora SRL" })
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 201, expect.anything());
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: fakeSupplier.id })
    );
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });
});
