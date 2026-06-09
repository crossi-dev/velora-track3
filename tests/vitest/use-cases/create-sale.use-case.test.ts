import { describe, it, expect, vi, beforeEach } from "vitest";

// demo-quota imports prisma at module load; mock it so the use-case test never touches the DB.
vi.mock("@/app/api/_lib/demo-quota", () => ({
  assertDemoQuota: vi.fn().mockResolvedValue(undefined),
  incrementDemoActionInTx: vi.fn().mockResolvedValue(undefined),
  DemoLimitReachedError: class DemoLimitReachedError extends Error { code = "DEMO_LIMIT_REACHED" as const; },
  isDemoQuotaEnabled: vi.fn().mockReturnValue(false),
}));

import { createSaleUseCase } from "@/application/use-cases/create-sale.use-case";
import type { BusinessRepositoryPort } from "@/domain/ports/business.repository.port";
import type { SaleRepositoryPort, CreateSaleTransactionResult } from "@/domain/ports/sale.repository.port";
import type { InventoryRepositoryPort } from "@/domain/ports/inventory.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";
import { ProductNotOwnedError, InsufficientStockError } from "@/domain/errors";

const mockTx = {} as Tx;

const fakeTxResult: CreateSaleTransactionResult = {
  sale: { id: "sale1", totalAmount: 100, status: "paid", date: new Date() },
  invoice: { id: "inv1", saleId: "sale1", invoiceNumber: "FC-0001", documentType: "X", issuedAt: new Date().toISOString(), currency: "ARS", totalAmount: 100, status: "issued", payload: {} },
  lowStockAlerts: [],
  whatsappPhone: null,
  notifyLowStockWa: false,
  auditMeta: { invoiceId: "inv1", invoiceNumber: "FC-0001", customerId: "", customerName: "Consumidor Final", totalAmount: 100, itemCount: 1 },
  idempotencyResponseBody: { sale: { id: "sale1", totalAmount: 100, status: "paid" }, invoice: {} as never },
};

const mockBusiness: BusinessRepositoryPort = {
  findById: vi.fn(),
  findCurrency: vi.fn(),
  findByUserId: vi.fn(),
  findForUpdate: vi.fn(),
  updateInTransaction: vi.fn(),
};

const mockSale: SaleRepositoryPort = {
  checkEntitiesExist: vi.fn().mockResolvedValue([]),
  createTransaction: vi.fn().mockResolvedValue(fakeTxResult),
};

const mockInventory: InventoryRepositoryPort = {
  loadForProducts: vi.fn().mockResolvedValue([
    { productId: "p1", quantity: 100, product: { businessId: "biz1", name: "Agua", costPrice: null, price: 100 } },
  ]),
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

const ports = { business: mockBusiness, sale: mockSale, inventory: mockInventory, idempotency: mockIdempotency, audit: mockAudit, transaction: mockTransaction };
const useCase = createSaleUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  actorRole: "owner" as const,
  customerId: null,
  items: [{ productId: "p1", quantity: 1, unitPrice: 100 }],
  fallbackCustomerName: "Consumidor Final",
  normalizedFallbackCustomerName: "consumidor final",
  idempotencyKey: "key-sale",
  actionMeta: { actionType: "sale.create", routeScope: "sales", resourceType: "Sale" },
  requestBody: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default begin returns execute so tests that only check the early-exit outcome don't crash.
  vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec0" });
  vi.mocked(mockBusiness.findById).mockResolvedValue({ id: "biz1", allowNegativeStock: false } as never);
  vi.mocked(mockSale.checkEntitiesExist).mockResolvedValue([]);
  vi.mocked(mockSale.createTransaction).mockResolvedValue(fakeTxResult);
  vi.mocked(mockInventory.loadForProducts).mockResolvedValue([
    { productId: "p1", quantity: 100, product: { businessId: "biz1", name: "Agua", costPrice: null, price: 100 } },
  ]);
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("createSaleUseCase", () => {
  it("returns business_not_found when business missing", async () => {
    vi.mocked(mockBusiness.findById).mockResolvedValue(null);
    expect((await useCase.execute(baseInput)).outcome).toBe("business_not_found");
  });

  it("returns entity_deleted when products missing", async () => {
    vi.mocked(mockSale.checkEntitiesExist).mockResolvedValue(["p1"]);
    expect((await useCase.execute(baseInput)).outcome).toBe("entity_deleted");
  });

  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 201, body: {} });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("creates sale, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "created", data: fakeTxResult });
    expect(mockSale.createTransaction).toHaveBeenCalledWith(mockTx, expect.objectContaining({ businessId: "biz1" }));
    // idempotency.complete is called with null (not mockTx) — the use-case runs it
    // outside the transaction so a commit-then-completion-failure leaves the row
    // pending for TTL cleanup rather than re-executing the sale on retry.
    expect(mockIdempotency.complete).toHaveBeenCalledWith(null, "rec1", 201, expect.anything());
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledOnce();
  });

  it("returns product_not_owned when inventory belongs to another business", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockInventory.loadForProducts).mockResolvedValue([
      { productId: "p1", quantity: 100, product: { businessId: "other-biz", name: "Agua", costPrice: null, price: 100 } },
    ]);

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("product_not_owned");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });

  it("returns insufficient_stock when createTransaction throws InsufficientStockError", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec3" });
    vi.mocked(mockSale.createTransaction).mockRejectedValue(new InsufficientStockError("Agua", 0));

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("insufficient_stock");
    if (result.outcome === "insufficient_stock") {
      expect(result.productName).toBe("Agua");
      expect(result.available).toBe(0);
    }
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec3");
  });

  it("releases idempotency and rethrows on unexpected error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec4" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("db error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("db error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec4");
  });
});
