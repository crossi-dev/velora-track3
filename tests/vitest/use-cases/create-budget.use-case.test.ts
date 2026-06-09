import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBudgetUseCase } from "@/application/use-cases/create-budget.use-case";
import type { BudgetRepositoryPort, BudgetRecord } from "@/domain/ports/budget.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const fakeBudget: BudgetRecord = {
  id: "bud1", budgetNumber: "PRE-0001", customerName: "Juan",
  customerId: null, note: null, currency: "ARS",
  totalAmount: 1000, status: "pending",
  createdAt: new Date(), updatedAt: new Date(),
  items: [{ id: "item1", productId: "p1", name: "Agua", quantity: 10, unitPrice: 100 }],
};

const mockBudget: BudgetRepositoryPort = {
  findById: vi.fn(),
  list: vi.fn(),
  createInTransaction: vi.fn().mockResolvedValue(fakeBudget),
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

const ports = { budget: mockBudget, idempotency: mockIdempotency, audit: mockAudit, transaction: mockTransaction };
const useCase = createBudgetUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  currency: "ARS",
  customerName: "Juan",
  customerId: null,
  note: null,
  totalAmount: 1000,
  items: [{ productId: "p1", name: "Agua", quantity: 10, unitPrice: 100 }],
  idempotencyKey: "key-bud",
  requestBody: {},
  actionMeta: { actionType: "budget.create", routeScope: "budgets", resourceType: "Budget" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockBudget.createInTransaction).mockResolvedValue(fakeBudget);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("createBudgetUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 201, body: { budget: fakeBudget } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("creates budget, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "created", budget: fakeBudget });
    expect(mockBudget.createInTransaction).toHaveBeenCalledWith(
      mockTx, expect.objectContaining({ businessId: "biz1", currency: "ARS", totalAmount: 1000 })
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 201, expect.objectContaining({ budget: fakeBudget }));
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: fakeBudget.id, summary: expect.stringContaining("PRE-0001") })
    );
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });
});
