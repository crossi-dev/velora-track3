import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProductUseCase } from "@/application/use-cases/create-product.use-case";
import type { ProductRepositoryPort, ProductRecord } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const fakeProduct: ProductRecord = {
  id: "prod1", name: "Coca Cola", price: 500, costPrice: null, sku: "CC-001", stock: 100,
};

const mockProduct: ProductRepositoryPort = {
  findForDelete: vi.fn(),
  createWithSkuRetry: vi.fn(),
  updateInTransaction: vi.fn(),
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

const ports = { product: mockProduct, idempotency: mockIdempotency, audit: mockAudit };
const useCase = createProductUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  name: "Coca Cola",
  price: 500,
  costPrice: null,
  initialStock: 100,
  stockReason: "Carga inicial",
  stockReferenceId: null,
  idempotencyKey: "key-prod",
  requestBody: {},
  actionMeta: { actionType: "product.create", routeScope: "products", resourceType: "Product" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockProduct.createWithSkuRetry).mockImplementation(async (_args, onCreated) => {
    await onCreated(mockTx, fakeProduct);
    return fakeProduct;
  });
});

describe("createProductUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 201, body: { product: fakeProduct } });
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

  it("creates product via callback, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "created", product: fakeProduct });
    expect(mockProduct.createWithSkuRetry).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz1", name: "Coca Cola", price: 500 }),
      expect.any(Function)
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 201, expect.anything());
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: fakeProduct.id })
    );
  });

  it("releases idempotency and rethrows when createWithSkuRetry throws", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockProduct.createWithSkuRetry).mockRejectedValue(new Error("sku conflict"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("sku conflict");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });
});
