import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateProductUseCase } from "@/application/use-cases/update-product.use-case";
import type { ProductRepositoryPort } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const fakeUpdateResult = { productId: "prod1", productName: "Coca Cola", updatedSku: "CC-001" };

const mockProduct: ProductRepositoryPort = {
  findForDelete: vi.fn(),
  createWithSkuRetry: vi.fn(),
  updateInTransaction: vi.fn().mockResolvedValue(fakeUpdateResult),
  deleteInTransaction: vi.fn(),
  fetchForBulkPriceUpdate: vi.fn(),
  bulkUpdatePricesInTransaction: vi.fn(),
  fetchNamesForAudit: vi.fn(),
  resolveOrCreateWithSkuRetry: vi.fn(),
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

const ports = { product: mockProduct, idempotency: mockIdempotency, audit: mockAudit, transaction: mockTransaction };
const useCase = updateProductUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  productId: "prod1",
  price: 600,
  stockReason: "Ajuste manual",
  stockReferenceId: null,
  productUpdateData: { price: 600 },
  idempotencyKey: "key-prod-upd",
  requestBody: {},
  actionMeta: { actionType: "product.update", routeScope: "products", resourceType: "Product" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockProduct.updateInTransaction).mockResolvedValue(fakeUpdateResult);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("updateProductUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { ok: true } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("updates product, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "updated", productId: "prod1", productName: "Coca Cola" });
    expect(mockProduct.updateInTransaction).toHaveBeenCalledWith(
      mockTx, expect.objectContaining({ businessId: "biz1", productId: "prod1", price: 600 })
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 200, { ok: true });
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "prod1" })
    );
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });
});
