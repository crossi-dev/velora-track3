import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateBusinessRuleUseCase } from "@/application/use-cases/update-business-rule.use-case";
import type { BusinessRuleRepositoryPort, BusinessRuleRecord } from "@/domain/ports/business-rule.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import { DemoLimitReachedError } from "@/app/api/_lib/demo-quota";

// ── fixtures ──────────────────────────────────────────────────────────────────

const existingRule: BusinessRuleRecord = {
  id: "rule-abc",
  kind: "behavior-based",
  trigger: "venta grande",
  message: "Avisar cuando supere $5000",
  active: true,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const updatedRule: BusinessRuleRecord = {
  ...existingRule,
  message: "Avisar cuando supere $10000",
  updatedAt: new Date("2026-06-01"),
};

// ── port mocks ────────────────────────────────────────────────────────────────

const mockBusinessRule: BusinessRuleRepositoryPort = {
  findByTrigger: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  update: vi.fn().mockResolvedValue(updatedRule),
  delete: vi.fn(),
  deactivateAllActiveByTrigger: vi.fn().mockResolvedValue({ count: 1 }),
};

const mockIdempotency: IdempotencyPort = {
  begin: vi.fn().mockResolvedValue({ kind: "execute", recordId: "rec-update-1" }),
  complete: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
};

const mockAudit: AuditPort = {
  recordCriticalWrite: vi.fn().mockResolvedValue(true),
};

const mockNotifyRuleEmployees = vi.fn().mockResolvedValue(undefined);
const mockInvalidateSupervisorContext = vi.fn();

const BASE_ACTION_META = {
  actionType: "business-rule.update",
  routeScope: "supervisor-internal/business-rules",
  resourceType: "BusinessRule",
};

const baseInput = {
  businessId: "biz-1",
  actorUserId: "user-1",
  ruleTrigger: "venta grande",
  updates: { message: "Avisar cuando supere $10000" },
  idempotencyKey: "key-update-1",
  requestBody: { ruleTrigger: "venta grande", updates: { message: "Avisar cuando supere $10000" } },
  actionMeta: BASE_ACTION_META,
};

function makePorts() {
  return {
    businessRule: mockBusinessRule,
    idempotency: mockIdempotency,
    audit: mockAudit,
    notifyRuleEmployees: mockNotifyRuleEmployees,
    invalidateSupervisorContext: mockInvalidateSupervisorContext,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockBusinessRule.findByTrigger).mockResolvedValue(existingRule as { id: string; kind: string });
  vi.mocked(mockBusinessRule.update).mockResolvedValue(updatedRule);
  vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec-update-1" });
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  mockNotifyRuleEmployees.mockResolvedValue(undefined);
  mockInvalidateSupervisorContext.mockReturnValue(undefined);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("updateBusinessRuleUseCase", () => {
  it("returns 'updated' and calls port.update when rule exists", async () => {
    const useCase = updateBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("updated");
    if (result.outcome === "updated") {
      expect(result.rule).toEqual(updatedRule);
    }
    expect(mockBusinessRule.update).toHaveBeenCalledWith(
      "biz-1",
      existingRule.id,
      { message: "Avisar cuando supere $10000" },
    );
  });

  it("returns 'not_found' when no rule matches the trigger", async () => {
    vi.mocked(mockBusinessRule.findByTrigger).mockResolvedValue(null);

    const useCase = updateBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("not_found");
    if (result.outcome === "not_found") {
      expect(result.ruleTrigger).toBe("venta grande");
    }
    expect(mockBusinessRule.update).not.toHaveBeenCalled();
    // idempotency must be released when not_found
    expect(mockIdempotency.release).toHaveBeenCalled();
  });

  it("returns 'idempotency_in_flight' when begin returns in_flight", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "in_flight" });

    const useCase = updateBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("idempotency_in_flight");
    expect(mockBusinessRule.update).not.toHaveBeenCalled();
  });

  it("returns 'replayed' on idempotency replay — no port.update call", async () => {
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { ok: true } });

    const useCase = updateBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("replayed");
    expect(mockBusinessRule.update).not.toHaveBeenCalled();
  });

  it("calls notifyRuleEmployees after a successful update", async () => {
    const useCase = updateBusinessRuleUseCase(makePorts());
    await useCase.execute(baseInput);

    expect(mockNotifyRuleEmployees).toHaveBeenCalledWith(
      "biz-1",
      existingRule.id,
      expect.stringContaining("actualizada"),
    );
  });

  it("calls invalidateSupervisorContext after a successful update", async () => {
    const useCase = updateBusinessRuleUseCase(makePorts());
    await useCase.execute(baseInput);

    expect(mockInvalidateSupervisorContext).toHaveBeenCalledWith("biz-1");
  });

  it("calls idempotency.complete after successful write", async () => {
    const useCase = updateBusinessRuleUseCase(makePorts());
    await useCase.execute(baseInput);

    expect(mockIdempotency.complete).toHaveBeenCalledWith(
      null,
      "rec-update-1",
      200,
      expect.any(Object),
    );
  });

  it("absorbs audit failure — rule still updated", async () => {
    vi.mocked(mockAudit.recordCriticalWrite).mockRejectedValue(new Error("audit down"));

    const useCase = updateBusinessRuleUseCase(makePorts());
    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("updated");
  });

  it("does NOT call prisma directly — only goes through port", async () => {
    // The use case must not import prisma. We verify indirectly:
    // port.update is the only allowed write path.
    const useCase = updateBusinessRuleUseCase(makePorts());
    await useCase.execute(baseInput);

    expect(mockBusinessRule.update).toHaveBeenCalledTimes(1);
  });

  // ── Bug 1: cron validation must use the rule's STORED kind, not a hardcoded default ─
  it("[JD Bug1] updating a time-based rule trigger to non-cron string is rejected when kind not sent", async () => {
    // The stored rule is time-based. Caller sends a trigger update but NO kind field.
    // The use-case must look up existing.kind ("time-based") from findByTrigger
    // and reject the free-text trigger as invalid cron.
    const timeBasedRule: BusinessRuleRecord = {
      ...existingRule,
      id: "rule-tb",
      kind: "time-based",
      trigger: "0 9 * * 1",
    };
    vi.mocked(mockBusinessRule.findByTrigger).mockResolvedValue(
      timeBasedRule as { id: string; kind: string },
    );

    const useCase = updateBusinessRuleUseCase(makePorts());
    const result = await useCase.execute({
      ...baseInput,
      ruleTrigger: "0 9 * * 1",
      // Sends a new trigger that is NOT a valid cron expression, and does NOT send kind.
      updates: { trigger: "every monday at 9am" },
    });

    // Must be rejected — cron validation must use stored kind "time-based".
    expect(result.outcome).toBe("cron_invalid");
    // Must not attempt the write.
    expect(mockBusinessRule.update).not.toHaveBeenCalled();
    // Idempotency must be released.
    expect(mockIdempotency.release).toHaveBeenCalled();
  });

  // ── Bug 2: notify failure must release idempotency, not leave it pending ──────
  it("[JD Bug2] notify throwing releases idempotency before rethrowing", async () => {
    const notifyError = new Error("notify failed");
    const mockNotifyThrowing = vi.fn().mockRejectedValue(notifyError);

    const ports = {
      businessRule: mockBusinessRule,
      idempotency: mockIdempotency,
      audit: mockAudit,
      notifyRuleEmployees: mockNotifyThrowing,
      invalidateSupervisorContext: mockInvalidateSupervisorContext,
    };
    const useCase = updateBusinessRuleUseCase(ports);

    await expect(useCase.execute(baseInput)).rejects.toThrow("notify failed");
    // Idempotency must be released (not left as pending) when notify throws.
    expect(mockIdempotency.release).toHaveBeenCalled();
    // complete must NOT have been called since notify failed before it.
    expect(mockIdempotency.complete).not.toHaveBeenCalled();
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
      notifyRuleEmployees: mockNotifyRuleEmployees,
      invalidateSupervisorContext: mockInvalidateSupervisorContext,
      assertDemoQuota: mockAssertDemoQuota,
    };
    const useCase = updateBusinessRuleUseCase(ports);
    const result = await useCase.execute(baseInput);

    // Must NOT proceed to update when demo quota exceeded.
    expect(mockBusinessRule.update).not.toHaveBeenCalled();
    // Idempotency must be released on quota exceeded.
    expect(mockIdempotency.release).toHaveBeenCalled();
    // Outcome should indicate quota exceeded.
    expect(result.outcome).toBe("demo_limit_reached");
  });
});
