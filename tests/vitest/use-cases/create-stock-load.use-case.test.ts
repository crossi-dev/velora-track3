import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStockLoadUseCase } from "@/application/use-cases/create-stock-load.use-case";
import type { StockLoadRepositoryPort, StockLoadAuditPort } from "@/domain/ports/stock-load.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const fakeBusiness = { name: "Tienda Demo", currency: "ARS", cuit: null, address: null };
const fakeSupplier = { id: "sup1", name: "Distribuidora SRL", phone: null, email: null, contactName: null };
const fakeProduct = { id: "prod1", name: "Agua mineral", price: 100, sku: "AG-001", currentQuantity: 50 };
const fakeInv = { stockMovementId: "sm1", stockMovementCreatedAt: new Date(), quantityAfter: 150, totalCost: 1000, cashMovementId: "cm1" };

const mockStockLoad: StockLoadRepositoryPort = {
  findBusinessDetails: vi.fn().mockResolvedValue(fakeBusiness),
  resolveSupplier: vi.fn().mockResolvedValue(fakeSupplier),
  resolveProduct: vi.fn().mockResolvedValue(fakeProduct),
  applyInventoryUpdate: vi.fn().mockResolvedValue(fakeInv),
  createPurchaseRequest: vi.fn().mockResolvedValue(undefined as never),
};

const mockStockLoadAudit: StockLoadAuditPort = {
  recordAudit: vi.fn().mockResolvedValue(undefined),
};

const mockIdempotency: IdempotencyPort = {
  begin: vi.fn(),
  complete: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
};

const mockTransaction: TransactionPort = {
  run: vi.fn(async (work) => work(mockTx)),
};

const ports = { stockLoad: mockStockLoad, stockLoadAudit: mockStockLoadAudit, idempotency: mockIdempotency, transaction: mockTransaction };
const useCase = createStockLoadUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  productId: "prod1",
  itemName: "Agua mineral",
  supplierId: "sup1",
  supplierName: "Distribuidora SRL",
  quantity: 100,
  unitPrice: 10,
  createPurchaseRequest: false,
  autoCreateProduct: false,
  idempotencyKey: "key-sl",
  actionMeta: { actionType: "stock-load.create", routeScope: "stock-loads", resourceType: "StockLoad" },
  requestBody: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockStockLoad.findBusinessDetails).mockResolvedValue(fakeBusiness);
  vi.mocked(mockStockLoad.resolveSupplier).mockResolvedValue(fakeSupplier);
  vi.mocked(mockStockLoad.resolveProduct).mockResolvedValue(fakeProduct);
  vi.mocked(mockStockLoad.applyInventoryUpdate).mockResolvedValue(fakeInv);
  vi.mocked(mockStockLoad.createPurchaseRequest).mockResolvedValue(undefined as never);
  vi.mocked(mockStockLoadAudit.recordAudit).mockResolvedValue(undefined);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("createStockLoadUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 201, body: {} });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("returns business_not_found when findBusinessDetails returns null", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });
    vi.mocked(mockStockLoad.findBusinessDetails).mockResolvedValue(null);

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("business_not_found");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec1");
  });

  it("returns product_not_found on PRODUCT_NOT_FOUND domain error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockStockLoad.resolveProduct).mockRejectedValue(new Error("PRODUCT_NOT_FOUND"));

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("product_not_found");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });

  it("creates stock load, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec3" });

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("created");
    expect(mockStockLoad.applyInventoryUpdate).toHaveBeenCalledWith(
      mockTx, expect.objectContaining({ businessId: "biz1", product: fakeProduct, quantity: 100 })
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec3", 201, expect.anything());
    expect(mockStockLoadAudit.recordAudit).toHaveBeenCalledOnce();
  });

  it("creates purchase request when createPurchaseRequest is true", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec4" });
    const fakePR = { id: "pr1", requestNumber: "OC-0001", issuedAt: "", currency: "ARS", totalAmount: 1000, payload: null };
    vi.mocked(mockStockLoad.createPurchaseRequest).mockResolvedValue(fakePR);

    await useCase.execute({ ...baseInput, createPurchaseRequest: true });

    expect(mockStockLoad.createPurchaseRequest).toHaveBeenCalledWith(
      mockTx, expect.objectContaining({ businessId: "biz1", supplier: fakeSupplier })
    );
  });

  it("releases idempotency and rethrows on unexpected error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec5" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("unexpected"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("unexpected");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec5");
  });
});
