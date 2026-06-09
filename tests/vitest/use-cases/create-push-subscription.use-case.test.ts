import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPushSubscriptionUseCase } from "@/application/use-cases/create-push-subscription.use-case";
import type { PushSubscriptionRepositoryPort, PushSubscriptionRecord } from "@/domain/ports/push-subscription.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const fakeSubscription: PushSubscriptionRecord = {
  id: "sub1",
};

const mockPushSubscription: PushSubscriptionRepositoryPort = {
  upsertInTransaction: vi.fn().mockResolvedValue(fakeSubscription),
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

const ports = { pushSubscription: mockPushSubscription, idempotency: mockIdempotency, audit: mockAudit, transaction: mockTransaction };
const useCase = createPushSubscriptionUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  endpoint: "https://push.example.com/sub1",
  p256dh: "key-abc",
  auth: "auth-xyz",
  deviceLabel: "iPhone de Carlos",
  idempotencyKey: "key-push",
  requestBody: {},
  actionMeta: { actionType: "push-subscription.create", routeScope: "push-subscriptions", resourceType: "PushSubscription" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockPushSubscription.upsertInTransaction).mockResolvedValue(fakeSubscription);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("createPushSubscriptionUseCase", () => {
  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { ok: true } });
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

  it("upserts subscription, completes idempotency, records audit", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "subscribed", subscription: fakeSubscription });
    expect(mockPushSubscription.upsertInTransaction).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ businessId: "biz1", endpoint: baseInput.endpoint })
    );
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 200, { ok: true });
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: fakeSubscription.id })
    );
  });

  it("audit summary omits device label when null", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });

    await useCase.execute({ ...baseInput, deviceLabel: null });

    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Suscripción push registrada" })
    );
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec3" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("upsert failed"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("upsert failed");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec3");
  });
});
