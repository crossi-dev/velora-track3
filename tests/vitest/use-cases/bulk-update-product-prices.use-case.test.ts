import { describe, it, expect, vi, beforeEach } from "vitest";
import { bulkUpdateProductPricesUseCase } from "@/application/use-cases/bulk-update-product-prices.use-case";
import type { ProductRepositoryPort } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const mockProduct: ProductRepositoryPort = {
  findForDelete: vi.fn(),
  createWithSkuRetry: vi.fn(),
  updateInTransaction: vi.fn(),
  deleteInTransaction: vi.fn(),
  fetchForBulkPriceUpdate: vi.fn(),
  bulkUpdatePricesInTransaction: vi.fn().mockResolvedValue(undefined),
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
const useCase = bulkUpdateProductPricesUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  amount: 10,
  mode: "percentage" as const,
  direction: "up" as const,
  productIds: ["prod1", "prod2"],
  idempotencyKey: "key-bulk",
  requestBody: {},
  actionMeta: { actionType: "product.bulk-price-update", routeScope: "products", resourceType: "Product" },
};

const fakeProducts = [
  { id: "prod1", name: "Agua", price: 100 },
  { id: "prod2", name: "Gaseosa", price: 200 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockProduct.bulkUpdatePricesInTransaction).mockResolvedValue(undefined as never);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("bulkUpdateProductPricesUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { updated: 2 } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("releases idempotency and returns no_products when list empty", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });
    vi.mocked(mockProduct.fetchForBulkPriceUpdate).mockResolvedValue([]);

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("no_products");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec1");
  });

  it("updates prices, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockProduct.fetchForBulkPriceUpdate).mockResolvedValue(fakeProducts);

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "updated", count: 2 });
    expect(mockProduct.bulkUpdatePricesInTransaction).toHaveBeenCalledWith(
      mockTx, "biz1",
      expect.arrayContaining([
        expect.objectContaining({ id: "prod1", newPrice: 110 }),
        expect.objectContaining({ id: "prod2", newPrice: 220 }),
      ])
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec2", 200, { updated: 2 });
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledOnce();
  });

  it("absolute down direction floors at 0.01 (never a free product)", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec3" });
    vi.mocked(mockProduct.fetchForBulkPriceUpdate).mockResolvedValue([{ id: "prod1", name: "Agua", price: 50 }]);

    await useCase.execute({ ...baseInput, amount: 200, mode: "absolute", direction: "down" });

    expect(mockProduct.bulkUpdatePricesInTransaction).toHaveBeenCalledWith(
      mockTx, "biz1",
      [expect.objectContaining({ id: "prod1", newPrice: 0.01 })]
    );
  });

  it("direction=set ignores old price", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec4" });
    vi.mocked(mockProduct.fetchForBulkPriceUpdate).mockResolvedValue([{ id: "prod1", name: "Agua", price: 999 }]);

    await useCase.execute({ ...baseInput, amount: 150, mode: "absolute", direction: "set" });

    expect(mockProduct.bulkUpdatePricesInTransaction).toHaveBeenCalledWith(
      mockTx, "biz1",
      [expect.objectContaining({ id: "prod1", newPrice: 150 })]
    );
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec5" });
    vi.mocked(mockProduct.fetchForBulkPriceUpdate).mockResolvedValue(fakeProducts);
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec5");
  });
});
