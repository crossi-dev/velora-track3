import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteBudgetUseCase } from "@/application/use-cases/delete-budget.use-case";
import type { BudgetRepositoryPort } from "@/domain/ports/budget.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const mockBudget: BudgetRepositoryPort = {
  findById: vi.fn(),
  list: vi.fn(),
  createInTransaction: vi.fn(),
  deleteInTransaction: vi.fn().mockResolvedValue(undefined),
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
const useCase = deleteBudgetUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  budgetId: "bud1",
  idempotencyKey: "key-bud-del",
  actionMeta: { actionType: "budget.delete", routeScope: "budgets", resourceType: "Budget" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockBudget.deleteInTransaction).mockResolvedValue(undefined);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("deleteBudgetUseCase", () => {
  it("returns not_found when budget missing", async () => {
    vi.mocked(mockBudget.findById).mockResolvedValue(null);
    expect((await useCase.execute(baseInput)).outcome).toBe("not_found");
  });

  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockBudget.findById).mockResolvedValue({ id: "bud1" });
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 204, body: null });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockBudget.findById).mockResolvedValue({ id: "bud1" });
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("deletes budget, completes idempotency, records audit", async () => {
    vi.mocked(mockBudget.findById).mockResolvedValue({ id: "bud1" });
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("deleted");
    expect(mockBudget.deleteInTransaction).toHaveBeenCalledWith(mockTx, "bud1", "biz1");
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 204, null);
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "bud1" })
    );
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockBudget.findById).mockResolvedValue({ id: "bud1" });
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });
});
