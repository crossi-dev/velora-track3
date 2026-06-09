// Tests that the supervisor create path routes through createBusinessRuleUseCase
// and maps its results to the { confirmation, error, affected } shape.
// Mirrors the update/delete wiring tests — no real DB, all ports mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBusinessRuleUseCase } from "@/application/use-cases/create-business-rule.use-case";
import type { BusinessRuleRepositoryPort, BusinessRuleRecord } from "@/domain/ports/business-rule.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import { DemoLimitReachedError } from "@/app/api/_lib/demo-quota";

// ── fixtures ──────────────────────────────────────────────────────────────────

const newRule: BusinessRuleRecord = {
  id: "rule-new-1", kind: "behavior-based", trigger: "venta grande",
  message: "Avisar al dueño cuando la venta supere $5000",
  active: true, createdAt: new Date("2026-06-01"), updatedAt: new Date("2026-06-01"),
};

const upsertedRule: BusinessRuleRecord = {
  ...newRule, id: "rule-existing-1", updatedAt: new Date("2026-06-01"),
};

// ── port mocks ────────────────────────────────────────────────────────────────

const mockBusinessRule: BusinessRuleRepositoryPort = {
  findByTrigger: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue(newRule),
  list: vi.fn(),
  update: vi.fn().mockResolvedValue(upsertedRule),
  delete: vi.fn(),
  deactivateAllActiveByTrigger: vi.fn().mockResolvedValue({ count: 0 }),
};

const mockIdempotency: IdempotencyPort = {
  begin: vi.fn().mockResolvedValue({ kind: "execute", recordId: "rec-create-1" }),
  complete: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
};

const mockAudit: AuditPort = {
  recordCriticalWrite: vi.fn().mockResolvedValue(true),
};

const mockNotify = vi.fn().mockResolvedValue(undefined);
const mockInvalidate = vi.fn();
const mockDemoQuota = vi.fn().mockResolvedValue(undefined);

const ACTION_META = {
  actionType: "business-rule.create",
  routeScope: "business/business-rules",
  resourceType: "BusinessRule",
};

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  kind: "behavior-based" as const,
  trigger: "venta grande",
  message: "Avisar al dueño cuando la venta supere $5000",
  idempotencyKey: "key-sup-1",
  requestBody: { kind: "behavior-based", trigger: "venta grande", message: "Avisar al dueño cuando la venta supere $5000" },
  actionMeta: ACTION_META,
  allowUpsertByTrigger: true,
};

function buildUseCase() {
  return createBusinessRuleUseCase({
    businessRule: mockBusinessRule,
    idempotency: mockIdempotency,
    classifier: async () => ({ kind: "behavior-based", cron: null }),
    audit: mockAudit,
    assertDemoQuota: mockDemoQuota,
    notifyRuleEmployees: mockNotify,
    invalidateSupervisorContext: mockInvalidate,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockBusinessRule.findByTrigger).mockResolvedValue(null);
  vi.mocked(mockBusinessRule.create).mockResolvedValue(newRule);
  vi.mocked(mockBusinessRule.update).mockResolvedValue(upsertedRule);
  vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec-create-1" });
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  mockNotify.mockResolvedValue(undefined);
  mockDemoQuota.mockResolvedValue(undefined);
});

// ── supervisor wiring tests ───────────────────────────────────────────────────

describe("createBusinessRuleUseCase — supervisor wiring (allowUpsertByTrigger=true)", () => {
  it("outcome=created on new trigger — calls create port, notifies, invalidates", async () => {
    const result = await buildUseCase().execute(baseInput);

    expect(result.outcome).toBe("created");
    if (result.outcome === "created") expect(result.rule).toBe(newRule);
    expect(mockBusinessRule.create).toHaveBeenCalledOnce();
    expect(mockNotify).toHaveBeenCalledWith("biz1", newRule.id, expect.stringContaining("Nueva regla"));
    expect(mockInvalidate).toHaveBeenCalledWith("biz1");
    expect(mockIdempotency.complete).toHaveBeenCalledOnce();
  });

  it("outcome=upserted on duplicate trigger — calls update port, notifies, invalidates", async () => {
    vi.mocked(mockBusinessRule.findByTrigger).mockResolvedValue({ id: "rule-existing-1", kind: "behavior-based" });

    const result = await buildUseCase().execute(baseInput);

    expect(result.outcome).toBe("upserted");
    if (result.outcome === "upserted") expect(result.rule).toBe(upsertedRule);
    expect(mockBusinessRule.create).not.toHaveBeenCalled();
    expect(mockBusinessRule.update).toHaveBeenCalledWith("biz1", "rule-existing-1", expect.objectContaining({ kind: "behavior-based", active: true }));
    expect(mockNotify).toHaveBeenCalledWith("biz1", upsertedRule.id, expect.stringContaining("Regla actualizada"));
    expect(mockInvalidate).toHaveBeenCalledWith("biz1");
    expect(mockIdempotency.complete).toHaveBeenCalledOnce();
  });

  it("outcome=demo_limit_reached when quota exceeded — releases idempotency", async () => {
    mockDemoQuota.mockRejectedValue(new DemoLimitReachedError("Demo limit"));

    const result = await buildUseCase().execute(baseInput);

    expect(result.outcome).toBe("demo_limit_reached");
    expect(mockIdempotency.release).toHaveBeenCalledOnce();
    expect(mockBusinessRule.create).not.toHaveBeenCalled();
  });

  it("outcome=invalid_trigger for bad cron — releases idempotency", async () => {
    const result = await buildUseCase().execute({
      ...baseInput,
      kind: "time-based",
      trigger: "not-a-cron",
    });

    expect(result.outcome).toBe("invalid_trigger");
    expect(mockIdempotency.release).toHaveBeenCalledOnce();
    expect(mockBusinessRule.create).not.toHaveBeenCalled();
  });

  it("idempotency seal: begin called with correct actionType", async () => {
    await buildUseCase().execute(baseInput);

    expect(mockIdempotency.begin).toHaveBeenCalledWith(expect.objectContaining({
      businessId: "biz1",
      actionType: "business-rule.create",
      idempotencyKey: "key-sup-1",
    }));
  });
});

describe("createBusinessRuleUseCase — REST caller (allowUpsertByTrigger=false/omitted)", () => {
  it("outcome=duplicate_trigger returned when allowUpsertByTrigger omitted — contract frozen for route.ts", async () => {
    vi.mocked(mockBusinessRule.findByTrigger).mockResolvedValue({ id: "rule-existing-1", kind: "behavior-based" });

    const result = await buildUseCase().execute({ ...baseInput, allowUpsertByTrigger: undefined });

    expect(result.outcome).toBe("duplicate_trigger");
    if (result.outcome === "duplicate_trigger") expect(result.existingId).toBe("rule-existing-1");
    expect(mockBusinessRule.update).not.toHaveBeenCalled();
    expect(mockIdempotency.release).toHaveBeenCalledOnce();
  });
});
