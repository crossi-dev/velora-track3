// tests/vitest/adk/owner-list-tools.test.ts
//
// Unit tests for list_customers + list_suppliers FunctionTools wired into the
// Owner Assistant (Phase 4 — read-only list capability).
//
// Calls tool.execute() directly (no ADK runner) — mirrors the pattern in
// tests/vitest/agents/package-profile-tool.test.ts.
//
// Tests:
//   list_customers tool:
//     - returns tenant-scoped customer rows (businessId from closure)
//     - optional search filter is forwarded to Prisma
//     - empty result is not an error
//     - DB error propagates (ADK runner surfaces it)
//     - businessId NEVER comes from args (closure-only)
//     - capped flag is true when result hits the 50-row limit
//     - null customer name is normalized to empty string
//   list_suppliers tool:
//     - returns tenant-scoped supplier rows (businessId from closure)
//     - optional search filter is forwarded to Prisma
//     - empty result is not an error
//     - DB error propagates
//     - businessId NEVER comes from args (closure-only)
//
// Mocked: @/lib/prisma (customer.findMany, supplier.findMany)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createListCustomersTool } from "@/lib/adk/tools/list-customers-tool";
import { createListSuppliersTool } from "@/lib/adk/tools/list-suppliers-tool";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { customerFindManyMock, supplierFindManyMock } = vi.hoisted(() => ({
  customerFindManyMock: vi.fn(),
  supplierFindManyMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customer: { findMany: customerFindManyMock },
    supplier: { findMany: supplierFindManyMock },
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCustomer(overrides: Partial<{ id: string; name: string | null; phone: string | null }> = {}) {
  return { id: "cust-001", name: "Ana García", phone: "+54911111111", ...overrides };
}

function makeSupplier(overrides: Partial<{ id: string; name: string; phone: string | null; contactName: string | null }> = {}) {
  return { id: "sup-001", name: "Distribuidora Norte", phone: "2612222333", contactName: "Pedro", ...overrides };
}

const BUSINESS_ID = "biz-test-list-001";

/** Calls a FunctionTool's execute function directly (bypasses ADK runner). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal for unit test (same pattern as package-profile-tool.test.ts)
async function exec(tool: ReturnType<typeof createListCustomersTool> | ReturnType<typeof createListSuppliersTool>, args: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal ADK property access
  return (tool as any).execute(args);
}

// ── list_customers ────────────────────────────────────────────────────────────

describe("list_customers tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns customers scoped to businessId from closure", async () => {
    customerFindManyMock.mockResolvedValue([
      makeCustomer({ id: "c1", name: "Ana García", phone: "+54911111111" }),
      makeCustomer({ id: "c2", name: "Juan Pérez", phone: null }),
    ]);

    const tool = createListCustomersTool({ businessId: BUSINESS_ID });
    const result = await exec(tool, {}) as {
      customers: { id: string; name: string; phone: string | null }[];
      total: number;
      capped: boolean;
    };

    expect(result.total).toBe(2);
    expect(result.customers[0].name).toBe("Ana García");
    expect(result.customers[1].phone).toBeNull();
    expect(result.capped).toBe(false);
  });

  it("passes businessId from closure to Prisma — never from args", async () => {
    customerFindManyMock.mockResolvedValue([]);

    const tool = createListCustomersTool({ businessId: BUSINESS_ID });
    await exec(tool, {});

    expect(customerFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ businessId: BUSINESS_ID }),
      }),
    );
  });

  it("forwards search filter to Prisma when provided", async () => {
    customerFindManyMock.mockResolvedValue([makeCustomer({ name: "García Laura" })]);

    const tool = createListCustomersTool({ businessId: BUSINESS_ID });
    await exec(tool, { search: "García" });

    expect(customerFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: expect.objectContaining({ contains: "García" }),
        }),
      }),
    );
  });

  it("omits name filter when search is empty string", async () => {
    customerFindManyMock.mockResolvedValue([]);

    const tool = createListCustomersTool({ businessId: BUSINESS_ID });
    await exec(tool, { search: "" });

    const callArgs = customerFindManyMock.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(callArgs.where).not.toHaveProperty("name");
  });

  it("returns empty list without error when no customers exist", async () => {
    customerFindManyMock.mockResolvedValue([]);

    const tool = createListCustomersTool({ businessId: BUSINESS_ID });
    const result = await exec(tool, {}) as { customers: unknown[]; total: number };

    expect(result.total).toBe(0);
    expect(result.customers).toHaveLength(0);
  });

  it("sets capped=true when result length equals the 50-row limit", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      makeCustomer({ id: `c${i}`, name: `Cliente ${i}` }),
    );
    customerFindManyMock.mockResolvedValue(rows);

    const tool = createListCustomersTool({ businessId: BUSINESS_ID });
    const result = await exec(tool, {}) as { capped: boolean; total: number };

    expect(result.capped).toBe(true);
    expect(result.total).toBe(50);
  });

  it("propagates DB errors (ADK runner will catch and surface them)", async () => {
    customerFindManyMock.mockRejectedValue(new Error("DB connection refused"));

    const tool = createListCustomersTool({ businessId: BUSINESS_ID });
    await expect(exec(tool, {})).rejects.toThrow("DB connection refused");
  });

  it("normalizes null customer name to empty string", async () => {
    customerFindManyMock.mockResolvedValue([makeCustomer({ name: null })]);

    const tool = createListCustomersTool({ businessId: BUSINESS_ID });
    const result = await exec(tool, {}) as { customers: { name: string }[] };

    expect(result.customers[0].name).toBe("");
  });
});

// ── list_suppliers ────────────────────────────────────────────────────────────

describe("list_suppliers tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns suppliers scoped to businessId from closure", async () => {
    supplierFindManyMock.mockResolvedValue([
      makeSupplier({ id: "s1", name: "Distribuidora Norte" }),
      makeSupplier({ id: "s2", name: "Lácteos del Valle", contactName: null }),
    ]);

    const tool = createListSuppliersTool({ businessId: BUSINESS_ID });
    const result = await exec(tool, {}) as {
      suppliers: { id: string; name: string; contactName: string | null }[];
      total: number;
      capped: boolean;
    };

    expect(result.total).toBe(2);
    expect(result.suppliers[0].name).toBe("Distribuidora Norte");
    expect(result.suppliers[1].contactName).toBeNull();
    expect(result.capped).toBe(false);
  });

  it("passes businessId from closure to Prisma — never from args", async () => {
    supplierFindManyMock.mockResolvedValue([]);

    const tool = createListSuppliersTool({ businessId: BUSINESS_ID });
    await exec(tool, {});

    expect(supplierFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ businessId: BUSINESS_ID }),
      }),
    );
  });

  it("forwards search filter when provided", async () => {
    supplierFindManyMock.mockResolvedValue([makeSupplier({ name: "Distribuidora Norte" })]);

    const tool = createListSuppliersTool({ businessId: BUSINESS_ID });
    await exec(tool, { search: "Distribuidora" });

    expect(supplierFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: expect.objectContaining({ contains: "Distribuidora" }),
        }),
      }),
    );
  });

  it("returns empty list without error when no suppliers exist", async () => {
    supplierFindManyMock.mockResolvedValue([]);

    const tool = createListSuppliersTool({ businessId: BUSINESS_ID });
    const result = await exec(tool, {}) as { suppliers: unknown[]; total: number };

    expect(result.total).toBe(0);
    expect(result.suppliers).toHaveLength(0);
  });

  it("propagates DB errors", async () => {
    supplierFindManyMock.mockRejectedValue(new Error("timeout"));

    const tool = createListSuppliersTool({ businessId: BUSINESS_ID });
    await expect(exec(tool, {})).rejects.toThrow("timeout");
  });
});
