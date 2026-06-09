// customer-lookup.test.ts
//
// Unit tests for the diacritic + typo-tolerant customer lookup functions.
// Both functions delegate to prisma.$queryRaw — tests mock that call to verify:
//   1. "Juan" input matches a customer stored as "Juan" (diacritic folding via unaccent)
//   2. "Juano" (typo) matches "Juan" (trigram similarity via pg_trgm)
//   3. Empty input returns null immediately (no DB call)
//   4. No DB rows returns null

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma before importing the modules under test.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { lookupCustomerSnapshot } from "@/lib/adk/tools/resolve-ventas-shipping-helpers";
import { lookupCustomerByName } from "@/app/api/business-assistant/_lib/nlu/execute-payment-link-fast-path-helpers";

const BUSINESS_ID = "biz-test-123";

const CUSTOMER_ROW = {
  id: "cust-1",
  name: "Juan",
  phone: "+5491112345678",
  address: "Calle Falsa 123",
  postalCode: "5500",
  city: "Mendoza",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── lookupCustomerSnapshot ────────────────────────────────────────────────────

describe("lookupCustomerSnapshot — diacritic + typo tolerance", () => {
  it("returns customer when unaccent folds 'Juan' to match stored 'Juan'", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([CUSTOMER_ROW]);

    const result = await lookupCustomerSnapshot(BUSINESS_ID, "Juan");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("cust-1");
    expect(result?.name).toBe("Juan");
    // Verify $queryRaw was called (not findFirst — the old ILIKE path)
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it("returns customer when trigram similarity matches typo 'Juano' → 'Juan'", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([CUSTOMER_ROW]);

    const result = await lookupCustomerSnapshot(BUSINESS_ID, "Juano");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("cust-1");
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it("returns null when DB returns no matching rows", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([]);

    const result = await lookupCustomerSnapshot(BUSINESS_ID, "Desconocido");

    expect(result).toBeNull();
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it("returns null immediately for empty customerName without hitting DB", async () => {
    const result = await lookupCustomerSnapshot(BUSINESS_ID, "");

    expect(result).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("maps all nullable fields correctly when DB returns null values", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { ...CUSTOMER_ROW, phone: null, address: null, postalCode: null, city: null },
    ]);

    const result = await lookupCustomerSnapshot(BUSINESS_ID, "Juan");

    expect(result?.phone).toBeNull();
    expect(result?.address).toBeNull();
    expect(result?.postalCode).toBeNull();
    expect(result?.city).toBeNull();
  });
});

// ── lookupCustomerByName ──────────────────────────────────────────────────────

describe("lookupCustomerByName — diacritic + typo tolerance", () => {
  it("returns customer when unaccent folds 'Juan' to match stored 'Juan'", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([CUSTOMER_ROW]);

    const result = await lookupCustomerByName(BUSINESS_ID, "Juan");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("cust-1");
    expect(result?.name).toBe("Juan");
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it("returns customer when trigram similarity matches typo 'Juano' → 'Juan'", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([CUSTOMER_ROW]);

    const result = await lookupCustomerByName(BUSINESS_ID, "Juano");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("cust-1");
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it("returns null when DB returns no matching rows", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([]);

    const result = await lookupCustomerByName(BUSINESS_ID, "Desconocido");

    expect(result).toBeNull();
  });

  it("returns null immediately for empty customerName without hitting DB", async () => {
    const result = await lookupCustomerByName(BUSINESS_ID, "");

    expect(result).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("maps all nullable fields correctly when DB returns null values", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { ...CUSTOMER_ROW, phone: null, address: null, postalCode: null, city: null },
    ]);

    const result = await lookupCustomerByName(BUSINESS_ID, "Juan");

    expect(result?.phone).toBeNull();
    expect(result?.address).toBeNull();
    expect(result?.postalCode).toBeNull();
    expect(result?.city).toBeNull();
  });
});
