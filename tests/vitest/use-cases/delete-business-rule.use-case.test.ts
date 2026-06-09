import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteBusinessRuleUseCase } from "@/application/use-cases/delete-business-rule.use-case";
import type { BusinessRuleRepositoryPort, BusinessRuleRecord } from "@/domain/ports/business-rule.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import { DemoLimitReachedError } from "@/app/api/_lib/demo-quota";

// ── fixtures ──────────────────────────────────────────────────────────────────

const existingRule: BusinessRuleRecord = {
  id: "rule-xyz",
  kind: "time-based",
  trigger: "0 9 * * 1",
  message: "Recordar reunión",
  active: true,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

// ── port mocks ────────────────────────────────────────────────────────────────

const mockBusinessRule: BusinessRuleRepositoryPort = {
  findByTrigger: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  update: vi.fn().mockResolvedValue({ ...existingRule, active: false }),
  delete: vi.fn(),
  deactivateAllActiveByTrigger: vi.fn().mockResolvedValue({ count: 1 }),
};

const mockIdempotency: IdempotencyPort = {
  begin: vi.fn().mockResolvedValue({ kind: "execute", recordId: "rec-delete-1" }),
  complete: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
};

const mockAudit: AuditPort = {
  recordCriticalWrite: vi.fn().mockResolvedValue(true),
};

const mockInvalidateSupervisorContext = vi.fn();

const BASE_ACTION_META = {
  actionType: "business-rule.delete",
  routeScope: "supervisor-internal/business-rules",
  resourceType: "BusinessRule",
};

const baseInput = {
  businessId: "biz-1",
  actorUserId: "user-1",
  ruleTrigger: "0 9 * * 1",
  idempotencyKey: "key-delete-1",
  requestBody: { ruleTrigger: "0 9 * * 1" },
  actionMeta: BASE_ACTION_META,
};

function makePorts() {
  return {
    businessRule: mockBusinessRule,
    idempotency: mockIdempotency,
    audit: mockAudit,
    invalidateSupervisorContext: mockInvalidateSupervisorContext,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockBusinessRule.findByTrigger).mockResolvedValue(existingRule as { id: string; kind: string });
  vi.mocked(mockBusinessRule.update).mockResolvedValue({ ...existingRule, active: false });
  vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec-delete-1" });
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  mockInvalidateSupervisorContext.mockReturnValue(undefined);
  vi.mocked(mockBusinessRule.deactivateAllActiveByTrigger!).mockResolvedValue({ count: 1 });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("deleteBusinessRuleUseCase", () => {
  it("returns 'deleted' with count=1 when rule found and deactivated", async () => {
    const useCase = deleteBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("deleted");
    if (result.outcome === "deleted") {
      expect(result.count).toBe(1);
    }
  });

  it("deactivates via deactivateAllActiveByTrigger (soft delete — does NOT call port.delete)", async () => {
    const useCase = deleteBusinessRuleUseCase(makePorts());
    await useCase.execute(baseInput);

    // Bug4 fix: soft delete uses deactivateAllActiveByTrigger (updateMany semantics).
    expect(mockBusinessRule.deactivateAllActiveByTrigger).toHaveBeenCalledWith("biz-1", "0 9 * * 1");
    // Hard delete must NOT be called
    expect(mockBusinessRule.delete).not.toHaveBeenCalled();
  });

  it("returns 'not_found' when no active rule matches the trigger (count=0)", async () => {
    // Bug3 fix: deactivateAllActiveByTrigger returns count=0 when no active rows exist.
    vi.mocked(mockBusinessRule.deactivateAllActiveByTrigger!).mockResolvedValue({ count: 0 });

    const useCase = deleteBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("not_found");
    if (result.outcome === "not_found") {
      expect(result.ruleTrigger).toBe("0 9 * * 1");
    }
    // idempotency must be released on not_found
    expect(mockIdempotency.release).toHaveBeenCalled();
  });

  it("returns 'idempotency_in_flight' when begin returns in_flight", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "in_flight" });

    const useCase = deleteBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("idempotency_in_flight");
    expect(mockBusinessRule.update).not.toHaveBeenCalled();
  });

  it("returns 'replayed' on idempotency replay — no port.update call", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { ok: true } });

    const useCase = deleteBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("replayed");
    expect(mockBusinessRule.update).not.toHaveBeenCalled();
  });

  it("does NOT call notifyRuleEmployees — delete has no notification side-effect", async () => {
    // The delete use-case must NOT notify employees (original behavior: exec body did not call notifyRuleEmployees).
    // We verify by confirming the ports object has no notifyRuleEmployees key used.
    // Since ports does not expose it, any attempt to call it would error — this test
    // asserts the outcome is still 'deleted' with no thrown error.
    const useCase = deleteBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);
    expect(result.outcome).toBe("deleted");
  });

  it("calls invalidateSupervisorContext after successful soft-delete", async () => {
    const useCase = deleteBusinessRuleUseCase(makePorts());
    await useCase.execute(baseInput);

    expect(mockInvalidateSupervisorContext).toHaveBeenCalledWith("biz-1");
  });

  it("calls idempotency.complete after successful soft-delete", async () => {
    const useCase = deleteBusinessRuleUseCase(makePorts());
    await useCase.execute(baseInput);

    expect(mockIdempotency.complete).toHaveBeenCalledWith(
      null,
      "rec-delete-1",
      200,
      expect.any(Object),
    );
  });

  it("absorbs audit failure — rule still soft-deleted", async () => {
    vi.mocked(mockAudit.recordCriticalWrite).mockRejectedValue(new Error("audit down"));

    const useCase = deleteBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("deleted");
  });

  // ── Bug 3: deleting an already-inactive rule must return 'not_found' ──────────
  it("[JD Bug3] deleting an already-inactive rule returns not_found (active filter)", async () => {
    // findByTrigger with active:true filter should return null for an inactive rule.
    // The use-case must use deactivateAllActiveByTrigger which only targets active rows.
    // When count=0, the use-case must treat it as not_found.
    vi.mocked(mockBusinessRule.deactivateAllActiveByTrigger!).mockResolvedValue({ count: 0 });

    const useCase = deleteBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("not_found");
    // Idempotency must be released when nothing was deactivated.
    expect(mockIdempotency.release).toHaveBeenCalled();
  });

  // ── Bug 4: soft-delete must deactivate ALL active matching rows ───────────────
  it("[JD Bug4] deactivates ALL active rows via deactivateAllActiveByTrigger (not just one)", async () => {
    // When there are 2 active rows with the same trigger, both must be deactivated.
    vi.mocked(mockBusinessRule.deactivateAllActiveByTrigger!).mockResolvedValue({ count: 2 });

    const useCase = deleteBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("deleted");
    if (result.outcome === "deleted") {
      expect(result.count).toBe(2);
    }
    // Must use the updateMany-style method, NOT port.update (which targets one row by id).
    expect(mockBusinessRule.deactivateAllActiveByTrigger).toHaveBeenCalledWith("biz-1", "0 9 * * 1");
    expect(mockBusinessRule.update).not.toHaveBeenCalled();
  });

  // ── Bug 5: demo quota must be checked after idempotency.begin ────────────────
  it("[JD Bug5] DemoLimitReachedError from assertDemoQuota releases idempotency", async () => {
    const mockAssertDemoQuota = vi.fn().mockRejectedValue(
      new DemoLimitReachedError("demo limit reached"),
    );
    const ports = {
      businessRule: mockBusinessRule,
      idempotency: mockIdempotency,
      audit: mockAudit,
      invalidateSupervisorContext: mockInvalidateSupervisorContext,
      assertDemoQuota: mockAssertDemoQuota,
    };
    const useCase = deleteBusinessRuleUseCase(ports);
    const result = await useCase.execute(baseInput);

    // Must NOT proceed to deactivate when demo quota exceeded.
    expect(mockBusinessRule.deactivateAllActiveByTrigger).not.toHaveBeenCalled();
    // Idempotency must be released on quota exceeded.
    expect(mockIdempotency.release).toHaveBeenCalled();
    // Outcome should indicate quota exceeded.
    expect(result.outcome).toBe("demo_limit_reached");
  });
});
