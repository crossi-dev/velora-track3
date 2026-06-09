import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCashMovementUseCase } from "@/application/use-cases/create-cash-movement.use-case";
import type { CashMovementRepositoryPort, CashMovementRecord } from "@/domain/ports/cash-movement.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;
const testDate = new Date("2026-05-01T10:00:00Z");

const fakeMovement: CashMovementRecord = {
  id: "mov1", type: "purchase", description: "Compra de insumos",
  amount: 500, date: testDate, saleId: null,
};

const mockCashMovements: CashMovementRepositoryPort = {
  createInTransaction: vi.fn().mockResolvedValue(fakeMovement),
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

const ports = { cashMovements: mockCashMovements, idempotency: mockIdempotency, audit: mockAudit, transaction: mockTransaction };
const useCase = createCashMovementUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  type: "purchase" as const,
  description: "Compra de insumos",
  amount: 500,
  date: testDate,
  idempotencyKey: "key-cm",
  requestBody: {},
  actionMeta: { actionType: "cash-movement.create", routeScope: "cash-movements", resourceType: "CashMovement" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockCashMovements.createInTransaction).mockResolvedValue(fakeMovement);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("createCashMovementUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 201, body: { movement: fakeMovement } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("returns idempotency_missing when key missing", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "missing" });
    expect((await useCase.execute(baseInput)).outcome).toBe("idempotency_missing");
  });

  it("creates movement, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "created", movement: expect.objectContaining({ id: "mov1" }) });
    expect(mockCashMovements.createInTransaction).toHaveBeenCalledWith(
      mockTx, expect.objectContaining({ businessId: "biz1", type: "purchase", amount: 500 })
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 201, expect.anything());
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "mov1", input: expect.anything(), after: expect.anything() })
    );
  });

  it("signCorrected is true when stored amount sign differs from input", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockCashMovements.createInTransaction).mockResolvedValue({ ...fakeMovement, amount: -500 });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "created", signCorrected: true });
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec3" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx error"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx error");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec3");
  });
});
