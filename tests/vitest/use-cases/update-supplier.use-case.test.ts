import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateSupplierUseCase } from "@/application/use-cases/update-supplier.use-case";
import type { SupplierRepositoryPort } from "@/domain/ports/supplier.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const mockSupplier: SupplierRepositoryPort = {
  findById: vi.fn(),
  createInTransaction: vi.fn(),
  updateInTransaction: vi.fn().mockResolvedValue(undefined),
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
const useCase = updateSupplierUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  supplierId: "sup1",
  name: "Nuevo Nombre",
  idempotencyKey: "key-sup-upd",
  requestBody: {},
  actionMeta: { actionType: "supplier.update", routeScope: "suppliers", resourceType: "Supplier" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockSupplier.updateInTransaction).mockResolvedValue(undefined);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("updateSupplierUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { ok: true } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("updates supplier, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("updated");
    expect(mockSupplier.updateInTransaction).toHaveBeenCalledWith(
      mockTx, expect.objectContaining({ businessId: "biz1", supplierId: "sup1", name: "Nuevo Nombre" })
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 200, { ok: true });
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "sup1" })
    );
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });
});
