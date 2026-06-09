import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveOrCreateProductUseCase } from "@/application/use-cases/resolve-or-create-product.use-case";
import type { ProductRepositoryPort } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { Tx } from "@/domain/ports/tx";

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
const useCase = resolveOrCreateProductUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  productName: "Coca Cola",
  normalizedName: "coca cola",
  price: 500,
  idempotencyKey: "key-abc",
  requestBody: {},
  actionMeta: { actionType: "product.resolve-or-create", routeScope: "products", resourceType: "Product" },
};

const fakeProduct = { id: "prod1", name: "Coca Cola", price: 500, costPrice: null, sku: "CC-001" };

beforeEach(() => {
  vi.clearAllMocks();
  mockIdempotency.complete = vi.fn().mockResolvedValue(undefined);
  mockIdempotency.release = vi.fn().mockResolvedValue(undefined);
  mockAudit.recordCriticalWrite = vi.fn().mockResolvedValue(true);
});

describe("resolveOrCreateProductUseCase", () => {
  it("returns replayed when idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { resolved: true } });
    const result = await useCase.execute(baseInput);
    expect(result).toEqual({ outcome: "replayed", status: 200, body: { resolved: true } });
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    const result = await useCase.execute(baseInput);
    expect(result.outcome).toBe("idempotency_missing");
  });

  it("returns idempotency_conflict on conflict", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "conflict" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_conflict");
  });

  it("returns idempotency_in_flight when in flight", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "in_flight" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_in_flight");
  });

  it("returns resolved and completes idempotency out-of-tx", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });
    vi.mocked(mockProduct.resolveOrCreateWithSkuRetry).mockResolvedValue({ outcome: "resolved", product: fakeProduct });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "resolved", product: fakeProduct });
    expect(mockIdempotency.complete).toHaveBeenCalledWith(null, "rec1", 200, expect.objectContaining({ resolved: true }));
    expect(mockAudit.recordCriticalWrite).not.toHaveBeenCalled();
  });

  it("returns created, records audit, completes idempotency in-tx", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockProduct.resolveOrCreateWithSkuRetry).mockImplementation(async (_biz, _args, _name, onCreated) => {
      await onCreated({} as Tx, fakeProduct);
      return { outcome: "created", product: fakeProduct };
    });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "created", product: fakeProduct });
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledOnce();
  });

  it("returns sku_collision and releases idempotency", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec3" });
    vi.mocked(mockProduct.resolveOrCreateWithSkuRetry).mockResolvedValue({ outcome: "sku_collision" });

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("sku_collision");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec3");
  });

  it("releases idempotency and rethrows on unexpected error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec4" });
    vi.mocked(mockProduct.resolveOrCreateWithSkuRetry).mockRejectedValue(new Error("db error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("db error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec4");
  });
});
