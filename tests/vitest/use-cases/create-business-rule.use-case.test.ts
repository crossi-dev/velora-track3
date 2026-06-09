import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBusinessRuleUseCase } from "@/application/use-cases/create-business-rule.use-case";
import type { BusinessRuleRepositoryPort, BusinessRuleRecord, BusinessRuleClassification } from "@/domain/ports/business-rule.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";

const fakeRule: BusinessRuleRecord = {
  id: "rule1", kind: "behavior-based", trigger: "venta grande",
  message: "Avisar al dueño cuando la venta supere $5000",
  active: true, createdAt: new Date(), updatedAt: new Date(),
};

const mockBusinessRule: BusinessRuleRepositoryPort = {
  findByTrigger: vi.fn(),
  create: vi.fn().mockResolvedValue(fakeRule),
  list: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  deactivateAllActiveByTrigger: vi.fn().mockResolvedValue({ count: 0 }),
};

const mockClassifier = vi.fn<(message: string) => Promise<BusinessRuleClassification>>();

const mockAudit: AuditPort = {
  recordCriticalWrite: vi.fn().mockResolvedValue(true),
};

const mockIdempotency: IdempotencyPort = {
  begin: vi.fn().mockResolvedValue({ kind: "execute", recordId: "rec1" }),
  complete: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
};

const ports = { businessRule: mockBusinessRule, idempotency: mockIdempotency, classifier: mockClassifier, audit: mockAudit };
const useCase = createBusinessRuleUseCase(ports);

const BASE_ACTION_META = {
  actionType: "business-rule.create",
  routeScope: "business/business-rules",
  resourceType: "BusinessRule",
};

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  trigger: "venta grande",
  message: "Avisar al dueño cuando la venta supere $5000",
  idempotencyKey: "test-key-1",
  requestBody: {},
  actionMeta: BASE_ACTION_META,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockBusinessRule.create).mockResolvedValue(fakeRule);
  mockClassifier.mockResolvedValue({ kind: "behavior-based", cron: null });
  vi.mocked(mockBusinessRule.findByTrigger).mockResolvedValue(null);
  vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
});

describe("createBusinessRuleUseCase", () => {
  it("returns duplicate_trigger when trigger already exists", async () => {
    vi.mocked(mockBusinessRule.findByTrigger).mockResolvedValue({ id: "existing-rule", kind: "behavior-based" });

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("duplicate_trigger");
    if (result.outcome === "duplicate_trigger") {
      expect(result.existingId).toBe("existing-rule");
    }
    expect(mockBusinessRule.create).not.toHaveBeenCalled();
  });

  it("creates rule and records audit for behavior-based trigger", async () => {
    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "created", rule: fakeRule });
    expect(mockBusinessRule.create).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz1", kind: "behavior-based", trigger: "venta grande" })
    );
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: fakeRule.id })
    );
  });

  it("uses cron trigger when classifier returns cron", async () => {
    mockClassifier.mockResolvedValue({ kind: "time-based", cron: "0 18 * * *" });

    await useCase.execute(baseInput);

    expect(mockBusinessRule.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "time-based", trigger: "0 18 * * *" })
    );
  });

  it("absorbs audit failure — rule still created", async () => {
    vi.mocked(mockAudit.recordCriticalWrite).mockRejectedValue(new Error("audit down"));

    const result = await useCase.execute(baseInput);

    expect(result.outcome).toBe("created");
  });
});
