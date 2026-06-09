import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPurchaseRequestUseCase } from "@/application/use-cases/create-purchase-request.use-case";
import type { PurchaseRequestRepositoryPort, PurchaseRequestRecord } from "@/domain/ports/purchase-request.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const fakeRequest: PurchaseRequestRecord = {
  id: "req1", requestNumber: "OC-0001", issuedAt: new Date().toISOString(),
  currency: "ARS", totalAmount: 500, payload: null,
};

const fakeAuditMeta = {
  requestId: "req1", requestNumber: "OC-0001",
  supplierId: "sup1", supplierName: "Distribuidora SRL",
  itemName: "Agua mineral", quantity: 50, unitPrice: 10, totalAmount: 500,
};

const mockPurchaseRequest: PurchaseRequestRepositoryPort = {
  list: vi.fn(),
  createInTransaction: vi.fn().mockResolvedValue({ request: fakeRequest, auditMeta: fakeAuditMeta }),
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

const ports = { purchaseRequest: mockPurchaseRequest, idempotency: mockIdempotency, audit: mockAudit, transaction: mockTransaction };
const useCase = createPurchaseRequestUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  supplierId: "sup1",
  supplierName: "Distribuidora SRL",
  itemName: "Agua mineral",
  quantity: 50,
  unitPrice: 10,
  idempotencyKey: "key-pr",
  requestBody: {},
  actionMeta: { actionType: "purchase-request.create", routeScope: "purchase-requests", resourceType: "PurchaseRequest" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockPurchaseRequest.createInTransaction).mockResolvedValue({ request: fakeRequest, auditMeta: fakeAuditMeta });
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("createPurchaseRequestUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 201, body: { request: fakeRequest } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("creates request, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "created", request: fakeRequest });
    expect(mockPurchaseRequest.createInTransaction).toHaveBeenCalledWith(
      mockTx, expect.objectContaining({ businessId: "biz1", supplierId: "sup1", itemName: "Agua mineral" })
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 201, expect.objectContaining({ request: fakeRequest }));
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "req1", summary: expect.stringContaining("OC-0001") })
    );
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });
});
