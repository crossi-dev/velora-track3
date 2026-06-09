// tests/vitest/mcp/owner-list-customers-suppliers-delegation.test.ts
//
// Verifies that list-customers-tool and list-suppliers-tool delegate to
// CustomerBackend.listCustomers / SupplierBackend.listSuppliers via port
// instead of calling prisma directly.
//
// Mirrors inventario-port-delegation.test.ts style:
//   (d1) list_customers: calls backend.listCustomers via port, NOT prisma
//   (d2) list_customers with search: passes search arg to port, NOT prisma
//   (d3) list_customers empty result: correct shape, prisma NOT called
//   (d4) list_suppliers: calls backend.listSuppliers via port, NOT prisma
//   (d5) list_suppliers with search: passes search arg to port, NOT prisma
//   (d6) list_suppliers empty result: correct shape, prisma NOT called
//   (d7) list_customers backendOverride: injected backend used (factory NOT called)
//   (d8) list_suppliers backendOverride: injected backend used (factory NOT called)
//
// No DB, no ADK runner, no real prisma.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock CustomerBackend factory ──────────────────────────────────────────────
// We mock the factory so the tool gets our mockCustomerBackend.

const mockCustomerBackend = {
  findCustomer: vi.fn(),
  listCustomers: vi.fn(),
  upsertCustomer: vi.fn(),
  deleteCustomer: vi.fn(),
};

vi.mock("@/lib/mcp/_lib/customer-backend.factory", () => ({
  createCustomerBackend: () => mockCustomerBackend,
}));

// ── Mock SupplierBackend factory ──────────────────────────────────────────────

const mockSupplierBackend = {
  listSuppliers: vi.fn(),
  createSupplier: vi.fn(),
  createPurchaseRequest: vi.fn(),
  editSupplier: vi.fn(),
  deleteSupplier: vi.fn(),
};

vi.mock("@/lib/mcp/_lib/supplier-backend.factory", () => ({
  createSupplierBackend: () => mockSupplierBackend,
}));

// ── Mock prisma — must NOT be called by tool bodies after the port migration ──
const prismaMock = {
  customer: { findMany: vi.fn() },
  supplier: { findMany: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("owner list tools — port delegation (no direct Prisma)", () => {
  const TRUSTED_BIZ_ID = "biz-owner-reads-001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── (d1) list_customers: delegates to port, NOT prisma ───────────────────

  it("(d1) list_customers: calls backend.listCustomers via port, NOT prisma.customer.findMany", async () => {
    mockCustomerBackend.listCustomers.mockResolvedValue([
      { id: "cust-1", name: "Ana García", phone: "+541112345678" },
      { id: "cust-2", name: "Bruno López", phone: null },
    ]);

    const { createListCustomersTool } = await import("@/lib/adk/tools/list-customers-tool");
    const tool = createListCustomersTool({ businessId: TRUSTED_BIZ_ID });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({});

    // Port called with correct tenantId
    expect(mockCustomerBackend.listCustomers).toHaveBeenCalledTimes(1);
    expect(mockCustomerBackend.listCustomers).toHaveBeenCalledWith({
      tenantId: TRUSTED_BIZ_ID,
      search: undefined,
    });

    // Prisma NOT called directly
    expect(prismaMock.customer.findMany).not.toHaveBeenCalled();

    // Correct response shape
    expect(result).toMatchObject({
      total: 2,
      capped: false,
      customers: [
        expect.objectContaining({ id: "cust-1", name: "Ana García", phone: "+541112345678" }),
        expect.objectContaining({ id: "cust-2", name: "Bruno López", phone: null }),
      ],
    });
  });

  // ── (d2) list_customers with search: search forwarded to port ────────────

  it("(d2) list_customers with search: passes search arg, NOT prisma", async () => {
    mockCustomerBackend.listCustomers.mockResolvedValue([
      { id: "cust-3", name: "Carlos Rossi", phone: "+5491155551234" },
    ]);

    const { createListCustomersTool } = await import("@/lib/adk/tools/list-customers-tool");
    const tool = createListCustomersTool({ businessId: TRUSTED_BIZ_ID });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({ search: "Carlos" });

    expect(mockCustomerBackend.listCustomers).toHaveBeenCalledTimes(1);
    expect(mockCustomerBackend.listCustomers).toHaveBeenCalledWith({
      tenantId: TRUSTED_BIZ_ID,
      search: "Carlos",
    });

    expect(prismaMock.customer.findMany).not.toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.customers[0].name).toBe("Carlos Rossi");
  });

  // ── (d3) list_customers empty: correct shape ─────────────────────────────

  it("(d3) list_customers empty result: correct shape, prisma NOT called", async () => {
    mockCustomerBackend.listCustomers.mockResolvedValue([]);

    const { createListCustomersTool } = await import("@/lib/adk/tools/list-customers-tool");
    const tool = createListCustomersTool({ businessId: TRUSTED_BIZ_ID });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({});

    expect(result).toMatchObject({ total: 0, capped: false, customers: [] });
    expect(prismaMock.customer.findMany).not.toHaveBeenCalled();
  });

  // ── (d4) list_suppliers: delegates to port, NOT prisma ───────────────────

  it("(d4) list_suppliers: calls backend.listSuppliers via port, NOT prisma.supplier.findMany", async () => {
    mockSupplierBackend.listSuppliers.mockResolvedValue([
      { id: "sup-1", name: "Distribuidora Norte", phone: "+543511234567", contactName: "Juan" },
      { id: "sup-2", name: "Proveedor Sur", phone: null, contactName: null },
    ]);

    const { createListSuppliersTool } = await import("@/lib/adk/tools/list-suppliers-tool");
    const tool = createListSuppliersTool({ businessId: TRUSTED_BIZ_ID });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({});

    // Port called with correct tenantId
    expect(mockSupplierBackend.listSuppliers).toHaveBeenCalledTimes(1);
    expect(mockSupplierBackend.listSuppliers).toHaveBeenCalledWith({
      tenantId: TRUSTED_BIZ_ID,
      search: undefined,
    });

    // Prisma NOT called directly
    expect(prismaMock.supplier.findMany).not.toHaveBeenCalled();

    // Correct response shape
    expect(result).toMatchObject({
      total: 2,
      capped: false,
      suppliers: [
        expect.objectContaining({ id: "sup-1", name: "Distribuidora Norte", contactName: "Juan" }),
        expect.objectContaining({ id: "sup-2", name: "Proveedor Sur", phone: null, contactName: null }),
      ],
    });
  });

  // ── (d5) list_suppliers with search: search forwarded to port ────────────

  it("(d5) list_suppliers with search: passes search arg, NOT prisma", async () => {
    mockSupplierBackend.listSuppliers.mockResolvedValue([
      { id: "sup-3", name: "Norte S.A.", phone: null, contactName: "María" },
    ]);

    const { createListSuppliersTool } = await import("@/lib/adk/tools/list-suppliers-tool");
    const tool = createListSuppliersTool({ businessId: TRUSTED_BIZ_ID });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({ search: "Norte" });

    expect(mockSupplierBackend.listSuppliers).toHaveBeenCalledTimes(1);
    expect(mockSupplierBackend.listSuppliers).toHaveBeenCalledWith({
      tenantId: TRUSTED_BIZ_ID,
      search: "Norte",
    });

    expect(prismaMock.supplier.findMany).not.toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.suppliers[0].name).toBe("Norte S.A.");
  });

  // ── (d6) list_suppliers empty: correct shape ─────────────────────────────

  it("(d6) list_suppliers empty result: correct shape, prisma NOT called", async () => {
    mockSupplierBackend.listSuppliers.mockResolvedValue([]);

    const { createListSuppliersTool } = await import("@/lib/adk/tools/list-suppliers-tool");
    const tool = createListSuppliersTool({ businessId: TRUSTED_BIZ_ID });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({});

    expect(result).toMatchObject({ total: 0, capped: false, suppliers: [] });
    expect(prismaMock.supplier.findMany).not.toHaveBeenCalled();
  });

  // ── (d7) list_customers backendOverride uses injected backend ────────────

  it("(d7) list_customers: backendOverride injected backend used (factory NOT called)", async () => {
    const injectedBackend = {
      findCustomer: vi.fn(),
      listCustomers: vi.fn().mockResolvedValue([
        { id: "cust-injected", name: "Injected Customer", phone: null },
      ]),
      upsertCustomer: vi.fn(),
      deleteCustomer: vi.fn(),
    };

    const { createListCustomersTool } = await import("@/lib/adk/tools/list-customers-tool");
    const tool = createListCustomersTool({
      businessId: TRUSTED_BIZ_ID,
      backendOverride: injectedBackend,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({});

    // Injected backend called, NOT the factory mock
    expect(injectedBackend.listCustomers).toHaveBeenCalledTimes(1);
    expect(injectedBackend.listCustomers).toHaveBeenCalledWith({
      tenantId: TRUSTED_BIZ_ID,
      search: undefined,
    });
    // Factory-created backend NOT called
    expect(mockCustomerBackend.listCustomers).not.toHaveBeenCalled();
    expect(prismaMock.customer.findMany).not.toHaveBeenCalled();

    expect(result.total).toBe(1);
    expect(result.customers[0].name).toBe("Injected Customer");
  });

  // ── (d8) list_suppliers backendOverride uses injected backend ────────────

  it("(d8) list_suppliers: backendOverride injected backend used (factory NOT called)", async () => {
    const injectedBackend = {
      listSuppliers: vi.fn().mockResolvedValue([
        { id: "sup-injected", name: "Injected Supplier", phone: null, contactName: null },
      ]),
      createSupplier: vi.fn(),
      createPurchaseRequest: vi.fn(),
      editSupplier: vi.fn(),
      deleteSupplier: vi.fn(),
    };

    const { createListSuppliersTool } = await import("@/lib/adk/tools/list-suppliers-tool");
    const tool = createListSuppliersTool({
      businessId: TRUSTED_BIZ_ID,
      backendOverride: injectedBackend,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({});

    // Injected backend called, NOT the factory mock
    expect(injectedBackend.listSuppliers).toHaveBeenCalledTimes(1);
    expect(injectedBackend.listSuppliers).toHaveBeenCalledWith({
      tenantId: TRUSTED_BIZ_ID,
      search: undefined,
    });
    // Factory-created backend NOT called
    expect(mockSupplierBackend.listSuppliers).not.toHaveBeenCalled();
    expect(prismaMock.supplier.findMany).not.toHaveBeenCalled();

    expect(result.total).toBe(1);
    expect(result.suppliers[0].name).toBe("Injected Supplier");
  });
});
