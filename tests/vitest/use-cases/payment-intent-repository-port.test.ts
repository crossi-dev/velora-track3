// TDD RED → GREEN: PaymentIntentRepositoryPort Prisma adapter
// Package 1, Task T1 — pure port/adapter, no wiring into callers.
// Verifies: CAS guard behavior for patchCheckout, findByIdAndBusiness tenant scoping.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Minimal prisma mock shape — only the paymentIntent delegate is needed.
function makeMockPrisma() {
  return {
    paymentIntent: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
  } as unknown as PrismaClient;
}

// Import the adapter under test. Vitest resolves '@' via alias in vitest.config.ts.
import { makePrismaPaymentIntentRepository } from "@/infrastructure/persistence/prisma-payment-intent.repository";

describe("PrismaPaymentIntentRepository", () => {
  let mockPrisma: ReturnType<typeof makeMockPrisma>;
  let repo: ReturnType<typeof makePrismaPaymentIntentRepository>;

  beforeEach(() => {
    mockPrisma = makeMockPrisma();
    repo = makePrismaPaymentIntentRepository(mockPrisma);
    vi.clearAllMocks();
  });

  // ── patchCheckout ────────────────────────────────────────────────────────────

  describe("patchCheckout", () => {
    it("calls updateMany with CAS WHERE providerRef: null", async () => {
      vi.mocked(mockPrisma.paymentIntent.updateMany).mockResolvedValue({ count: 1 });

      const result = await repo.patchCheckout({
        paymentIntentId: "pi_1",
        businessId: "biz_1",
        providerRef: "pref_abc",
        checkoutUrl: "https://mp.com/checkout/abc",
      });

      expect(result).toEqual({ count: 1 });
      expect(mockPrisma.paymentIntent.updateMany).toHaveBeenCalledWith({
        where: { id: "pi_1", businessId: "biz_1", providerRef: null },
        data: { providerRef: "pref_abc", checkoutUrl: "https://mp.com/checkout/abc" },
      });
    });

    it("returns { count: 0 } when providerRef already set (CAS miss)", async () => {
      vi.mocked(mockPrisma.paymentIntent.updateMany).mockResolvedValue({ count: 0 });

      const result = await repo.patchCheckout({
        paymentIntentId: "pi_1",
        businessId: "biz_1",
        providerRef: "pref_duplicate",
        checkoutUrl: "https://mp.com/checkout/dup",
      });

      expect(result).toEqual({ count: 0 });
    });

    it("scopes WHERE by businessId for tenant isolation", async () => {
      vi.mocked(mockPrisma.paymentIntent.updateMany).mockResolvedValue({ count: 0 });

      await repo.patchCheckout({
        paymentIntentId: "pi_1",
        businessId: "tenant_B",
        providerRef: "pref_x",
        checkoutUrl: "https://mp.com/x",
      });

      const callArgs = vi.mocked(mockPrisma.paymentIntent.updateMany).mock.calls[0]?.[0];
      expect(callArgs?.where).toMatchObject({ businessId: "tenant_B" });
    });
  });

  // ── findByIdAndBusiness ──────────────────────────────────────────────────────

  describe("findByIdAndBusiness", () => {
    it("returns providerRef when found", async () => {
      vi.mocked(mockPrisma.paymentIntent.findFirst).mockResolvedValue({
        providerRef: "pref_existing",
      } as ReturnType<typeof mockPrisma.paymentIntent.findFirst> extends Promise<infer R> ? R : never);

      const result = await repo.findByIdAndBusiness("pi_1", "biz_1");

      expect(result).toEqual({ providerRef: "pref_existing" });
      expect(mockPrisma.paymentIntent.findFirst).toHaveBeenCalledWith({
        where: { id: "pi_1", businessId: "biz_1" },
        select: { providerRef: true },
      });
    });

    it("returns null when not found", async () => {
      vi.mocked(mockPrisma.paymentIntent.findFirst).mockResolvedValue(null);

      const result = await repo.findByIdAndBusiness("pi_missing", "biz_1");

      expect(result).toBeNull();
    });

    it("scopes findFirst by businessId for tenant isolation", async () => {
      vi.mocked(mockPrisma.paymentIntent.findFirst).mockResolvedValue(null);

      await repo.findByIdAndBusiness("pi_1", "tenant_A");

      const callArgs = vi.mocked(mockPrisma.paymentIntent.findFirst).mock.calls[0]?.[0];
      expect(callArgs?.where).toMatchObject({ businessId: "tenant_A" });
    });
  });
});
