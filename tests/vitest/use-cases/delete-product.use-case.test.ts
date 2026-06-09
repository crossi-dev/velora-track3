import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteProductUseCase } from "@/application/use-cases/delete-product.use-case";
import type { ProductRepositoryPort, ProductForDelete } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const fakeProduct: ProductForDelete = {
  id: "prod1", name: "Coca Cola", price: 500, stock: 10, sku: "CC-001",
  costPrice: null, saleItemsCount: 0, stockMovementsCount: 0,
};

const mockProduct: ProductRepositoryPort = {
  findForDelete: vi.fn(),
  createWithSkuRetry: vi.fn(),
  updateInTransaction: vi.fn(),
  deleteInTransaction: vi.fn().mockResolvedValue({ archived: false }),
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
const useCase = deleteProductUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  productId: "prod1",
  idempotencyKey: "key-prod-del",
  actionMeta: { actionType: "product.delete", routeScope: "products", resourceType: "Product" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockProduct.deleteInTransaction).mockResolvedValue({ archived: false });
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("deleteProductUseCase", () => {
  it("returns not_found when product missing", async () => {
    vi.mocked(mockProduct.findForDelete).mockResolvedValue(null);
    expect((await useCase.execute(baseInput)).outcome).toBe("not_found");
  });

  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockProduct.findForDelete).mockResolvedValue(fakeProduct);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { ok: true } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("deletes (hard) product, completes idempotency, records audit", async () => {
    vi.mocked(mockProduct.findForDelete).mockResolvedValue(fakeProduct);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "deleted", archived: false });
    expect(mockProduct.deleteInTransaction).toHaveBeenCalledWith(
      mockTx, expect.objectContaining({ businessId: "biz1", productId: "prod1" })
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 200, { ok: true, archived: false });
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "prod1", summary: expect.stringContaining("eliminado") })
    );
  });

  it("archives when product has sale items", async () => {
    vi.mocked(mockProduct.findForDelete).mockResolvedValue({ ...fakeProduct, saleItemsCount: 3 });
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockProduct.deleteInTransaction).mockResolvedValue({ archived: true });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "deleted", archived: true });
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining("archivado") })
    );
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockProduct.findForDelete).mockResolvedValue(fakeProduct);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec3" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec3");
  });
});
