// TDD RED → GREEN: DelegationPolicyRepositoryPort Prisma adapter
// Package 1, Task T3 — pure port/adapter, no wiring into callers.
// Verifies: create, findActiveByScope, update, softDeleteByScope with tenant isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient, DelegationPolicy } from "@prisma/client";

// Minimal prisma mock shape — only the delegationPolicy delegate is needed.
function makeMockPrisma() {
  return {
    delegationPolicy: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  } as unknown as PrismaClient;
}

// Cast a partial mock row to the Prisma return type. The adapter only reads
// id/scope/maxValue/requiresOwner/conditions/active, and maxValue is exercised
// via a Decimal-like { toNumber } stub — the full Decimal shape is irrelevant here.
function dpRow(o: Record<string, unknown>): DelegationPolicy {
  return o as unknown as DelegationPolicy;
}

import { makePrismaDelegationPolicyRepository } from "@/infrastructure/persistence/prisma-delegation-policy.repository";

const baseRecord = {
  id: "dp_1",
  scope: "max_sale_amount",
  maxValue: { toNumber: () => 5000 },
  requiresOwner: false,
  conditions: "{}",
  active: true,
};

describe("PrismaDelegationPolicyRepository", () => {
  let mockPrisma: ReturnType<typeof makeMockPrisma>;
  let repo: ReturnType<typeof makePrismaDelegationPolicyRepository>;

  beforeEach(() => {
    mockPrisma = makeMockPrisma();
    repo = makePrismaDelegationPolicyRepository(mockPrisma);
    vi.clearAllMocks();
  });

  // ── findActiveByScope ────────────────────────────────────────────────────────

  describe("findActiveByScope", () => {
    it("returns { id } when an active policy exists for the scope", async () => {
      vi.mocked(mockPrisma.delegationPolicy.findFirst).mockResolvedValue(dpRow({ id: "dp_1" }));

      const result = await repo.findActiveByScope("biz_1", "max_sale_amount");

      expect(result).toEqual({ id: "dp_1" });
      expect(mockPrisma.delegationPolicy.findFirst).toHaveBeenCalledWith({
        where: { businessId: "biz_1", scope: "max_sale_amount", active: true },
        select: { id: true },
      });
    });

    it("returns null when no active policy exists for the scope", async () => {
      vi.mocked(mockPrisma.delegationPolicy.findFirst).mockResolvedValue(null);

      const result = await repo.findActiveByScope("biz_1", "unknown_scope");

      expect(result).toBeNull();
    });

    it("scopes query by businessId for tenant isolation", async () => {
      vi.mocked(mockPrisma.delegationPolicy.findFirst).mockResolvedValue(null);

      await repo.findActiveByScope("tenant_B", "max_sale_amount");

      const callArgs = vi.mocked(mockPrisma.delegationPolicy.findFirst).mock.calls[0]?.[0];
      expect(callArgs?.where).toMatchObject({ businessId: "tenant_B" });
    });
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe("create", () => {
    it("returns a DelegationPolicyRecord with all supplied fields", async () => {
      vi.mocked(mockPrisma.delegationPolicy.create).mockResolvedValue(
        dpRow({ ...baseRecord, id: "dp_new", maxValue: { toNumber: () => 3000 } }),
      );

      const result = await repo.create({
        businessId: "biz_1",
        scope: "max_sale_amount",
        maxValue: 3000,
        requiresOwner: false,
        conditions: "{}",
      });

      expect(result).toMatchObject({
        id: "dp_new",
        scope: "max_sale_amount",
        maxValue: 3000,
        requiresOwner: false,
        conditions: "{}",
        active: true,
      });
    });

    it("calls delegationPolicy.create with correct data and scopes by businessId", async () => {
      vi.mocked(mockPrisma.delegationPolicy.create).mockResolvedValue(dpRow(baseRecord));

      await repo.create({
        businessId: "biz_1",
        scope: "max_sale_amount",
        maxValue: 5000,
        requiresOwner: false,
        conditions: "{}",
      });

      expect(mockPrisma.delegationPolicy.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            businessId: "biz_1",
            scope: "max_sale_amount",
            maxValue: 5000,
            requiresOwner: false,
            conditions: "{}",
            active: true,
          }),
        }),
      );
    });

    it("handles null maxValue (policy without numeric limit)", async () => {
      vi.mocked(mockPrisma.delegationPolicy.create).mockResolvedValue(
        dpRow({ ...baseRecord, maxValue: null }),
      );

      const result = await repo.create({
        businessId: "biz_1",
        scope: "always_escalate",
        maxValue: null,
        requiresOwner: true,
        conditions: "{}",
      });

      expect(result.maxValue).toBeNull();
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe("update", () => {
    it("returns updated record when policy exists", async () => {
      vi.mocked(mockPrisma.delegationPolicy.findFirst).mockResolvedValue(dpRow({ id: "dp_1" }));
      vi.mocked(mockPrisma.delegationPolicy.update).mockResolvedValue(
        dpRow({ ...baseRecord, maxValue: { toNumber: () => 8000 } }),
      );

      const result = await repo.update("biz_1", "dp_1", { maxValue: 8000 });

      expect(result).toMatchObject({ id: "dp_1", maxValue: 8000 });
    });

    it("returns null when policy does not exist for businessId", async () => {
      vi.mocked(mockPrisma.delegationPolicy.findFirst).mockResolvedValue(null);

      const result = await repo.update("biz_1", "dp_missing", { maxValue: 8000 });

      expect(result).toBeNull();
      expect(mockPrisma.delegationPolicy.update).not.toHaveBeenCalled();
    });

    it("scopes the update by businessId for tenant isolation", async () => {
      vi.mocked(mockPrisma.delegationPolicy.findFirst).mockResolvedValue(dpRow({ id: "dp_1" }));
      vi.mocked(mockPrisma.delegationPolicy.update).mockResolvedValue(dpRow(baseRecord));

      await repo.update("tenant_A", "dp_1", { requiresOwner: true });

      expect(mockPrisma.delegationPolicy.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "dp_1", businessId: "tenant_A" },
        }),
      );
    });
  });

  // ── softDeleteByScope ────────────────────────────────────────────────────────

  describe("softDeleteByScope", () => {
    it("returns { count: 1 } when active policy exists for the scope", async () => {
      vi.mocked(mockPrisma.delegationPolicy.updateMany).mockResolvedValue({ count: 1 });

      const result = await repo.softDeleteByScope("biz_1", "max_sale_amount");

      expect(result).toEqual({ count: 1 });
      expect(mockPrisma.delegationPolicy.updateMany).toHaveBeenCalledWith({
        where: { businessId: "biz_1", scope: "max_sale_amount", active: true },
        data: { active: false },
      });
    });

    it("returns { count: 0 } when no active policy exists for the scope", async () => {
      vi.mocked(mockPrisma.delegationPolicy.updateMany).mockResolvedValue({ count: 0 });

      const result = await repo.softDeleteByScope("biz_1", "nonexistent_scope");

      expect(result).toEqual({ count: 0 });
    });

    it("scopes updateMany by businessId for tenant isolation", async () => {
      vi.mocked(mockPrisma.delegationPolicy.updateMany).mockResolvedValue({ count: 0 });

      await repo.softDeleteByScope("tenant_C", "max_sale_amount");

      const callArgs = vi.mocked(mockPrisma.delegationPolicy.updateMany).mock.calls[0]?.[0];
      expect(callArgs?.where).toMatchObject({ businessId: "tenant_C" });
    });
  });
});
