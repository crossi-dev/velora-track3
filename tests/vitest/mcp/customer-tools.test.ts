// tests/vitest/mcp/customer-tools.test.ts
//
// Unit tests for the customer MCP tool registrations (customer-tools.ts).
// Uses InMemoryTransport.createLinkedPair() from the MCP SDK — mirrors
// the ventas-tools.test.ts / messaging-tools.test.ts style.
//
// Mocked dependencies:
//   - @/lib/prisma  — customer.findMany (find_customer)
//                  — $transaction (upsert_customer)
//   - @/infrastructure/shared/customer-mutations — createCustomerInTransaction,
//                                                  updateCustomerInTransaction
//
// No real DB calls are made. Tests cover:
//   - tools/list includes find_customer + upsert_customer when businessId present
//   - tools NOT registered when no businessId
//   - find_customer: happy path (name search returns matching customers)
//   - find_customer: phone search
//   - find_customer: missing params → isError: true (MISSING_SEARCH_PARAMS)
//   - find_customer: empty result is NOT an error
//   - find_customer: DB failure → isError: true
//   - find_customer: businessId comes from closure (never from tool input)
//   - upsert_customer: create path (no customerId) → returns new customer
//   - upsert_customer: update path (with customerId) → calls update
//   - upsert_customer: phone-based upsert (existing customer returned by create tx)
//   - upsert_customer: domain error (CUSTOMER_NOT_FOUND) → isError: true
//   - upsert_customer: tenant-scoped — businessId from closure
//
// Pre-existing vitest failures on main (sale-post-commit-chain, employee-auth-edge)
// are unrelated — verify this file's pass count independently.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  customerFindManyMock,
  prismaTxMock,
  createCustomerInTransactionMock,
  updateCustomerInTransactionMock,
} = vi.hoisted(() => ({
  customerFindManyMock: vi.fn(),
  prismaTxMock: vi.fn(),
  createCustomerInTransactionMock: vi.fn(),
  updateCustomerInTransactionMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customer: { findMany: customerFindManyMock },
    $transaction: prismaTxMock,
    // Other models stubbed to avoid failures from fiscal/payments/ventas/logistica tools
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    courierCredential: { findMany: vi.fn().mockResolvedValue([]) },
    mpConnection: { findUnique: vi.fn().mockResolvedValue(null) },
    // Stub for resolveTenantBackendMap — null = all env / "velora" defaults
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/infrastructure/shared/customer-mutations", () => ({
  createCustomerInTransaction: createCustomerInTransactionMock,
  updateCustomerInTransaction: updateCustomerInTransactionMock,
  normalizeCustomerName: (v: unknown) => (typeof v === "string" ? v.trim() : null),
  normalizeCustomerNullableText: (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null),
}));

// ── Types ─────────────────────────────────────────────────────────────────────

interface TextContent {
  type: "text";
  text: string;
}

interface CallToolResult {
  isError?: boolean;
  content: TextContent[];
}

function asToolResult(raw: unknown): CallToolResult {
  return raw as CallToolResult;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildConnectedClient(businessId?: string): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await buildVeloraMcpServer(businessId);
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

function makeCustomerRow(overrides: Partial<{
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}> = {}) {
  return {
    id: "cust-001",
    name: "María García",
    phone: "+541151234567",
    email: "maria@example.com",
    address: "Corrientes 1234",
    postalCode: "1043",
    city: "Buenos Aires",
    ...overrides,
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("customer tools — registration", () => {
  it("includes find_customer and upsert_customer when businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-cust-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("find_customer");
      expect(names).toContain("upsert_customer");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include customer tools when no businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("find_customer");
      expect(names).not.toContain("upsert_customer");
    } finally {
      await cleanup();
    }
  });
});

// ── find_customer ─────────────────────────────────────────────────────────────

describe("find_customer tool", () => {
  const BUSINESS_ID = "biz-find-cust-001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns matching customers on name search", async () => {
    customerFindManyMock.mockResolvedValue([
      makeCustomerRow({ id: "cust-001", name: "María García" }),
      makeCustomerRow({ id: "cust-002", name: "María López", phone: null }),
    ]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "find_customer",
        arguments: { name: "María" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        customers: Array<{ id: string; name: string }>;
        total: number;
      };
      expect(parsed.total).toBe(2);
      expect(parsed.customers[0].name).toBe("María García");
      expect(parsed.customers[1].name).toBe("María López");
    } finally {
      await cleanup();
    }
  });

  it("returns matching customers on phone search", async () => {
    customerFindManyMock.mockResolvedValue([
      makeCustomerRow({ id: "cust-003", name: "Juan Pérez", phone: "+541151111111" }),
    ]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "find_customer",
        arguments: { phone: "1151111111" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        customers: Array<{ id: string; name: string; phone: string }>;
        total: number;
      };
      expect(parsed.total).toBe(1);
      expect(parsed.customers[0].phone).toBe("+541151111111");
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true (MISSING_SEARCH_PARAMS) when neither name nor phone provided", async () => {
    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "find_customer",
        arguments: {},
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("MISSING_SEARCH_PARAMS");
    } finally {
      await cleanup();
    }
  });

  it("returns empty list when no customers match (not isError)", async () => {
    customerFindManyMock.mockResolvedValue([]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "find_customer",
        arguments: { name: "NonexistentName" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { customers: unknown[]; total: number };
      expect(parsed.total).toBe(0);
      expect(parsed.customers).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true on DB failure", async () => {
    customerFindManyMock.mockRejectedValue(new Error("DB connection refused"));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "find_customer",
        arguments: { name: "María" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe("CUSTOMER_QUERY_ERROR");
      expect(parsed.message).toContain("DB connection refused");
    } finally {
      await cleanup();
    }
  });

  it("passes businessId from closure — findMany is called with businessId in the AND clause", async () => {
    customerFindManyMock.mockResolvedValue([]);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "find_customer",
        arguments: { name: "Test" },
      });
      expect(customerFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({ businessId: BUSINESS_ID }),
            ]),
          }),
        }),
      );
    } finally {
      await cleanup();
    }
  });
});

// ── upsert_customer ───────────────────────────────────────────────────────────

describe("upsert_customer tool", () => {
  const BUSINESS_ID = "biz-upsert-cust-001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new customer (no customerId) — returns the created record", async () => {
    const created = makeCustomerRow({ id: "cust-new-001", name: "Nuevo Cliente" });
    createCustomerInTransactionMock.mockResolvedValue(created);
    // $transaction calls the callback with a tx object and returns the result.
    prismaTxMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "upsert_customer",
        arguments: { name: "Nuevo Cliente", phone: "+541150000000" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        customer: { id: string; name: string };
      };
      expect(parsed.customer.id).toBe("cust-new-001");
      expect(parsed.customer.name).toBe("Nuevo Cliente");
      expect(createCustomerInTransactionMock).toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("updates an existing customer when customerId is provided", async () => {
    const updated = makeCustomerRow({ id: "cust-existing-001", name: "María García Actualizada" });
    updateCustomerInTransactionMock.mockResolvedValue(updated);
    prismaTxMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "upsert_customer",
        arguments: {
          customerId: "cust-existing-001",
          name: "María García Actualizada",
        },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        customer: { id: string; name: string };
      };
      expect(parsed.customer.id).toBe("cust-existing-001");
      expect(updateCustomerInTransactionMock).toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("returns existing customer on phone-based upsert (phone already exists — create returns existing)", async () => {
    // createCustomerInTransaction returns the existing customer when phone already exists.
    const existing = makeCustomerRow({ id: "cust-phone-001", name: "Cliente Existente", phone: "+541159999999" });
    createCustomerInTransactionMock.mockResolvedValue(existing);
    prismaTxMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "upsert_customer",
        arguments: { name: "Nombre Diferente", phone: "+541159999999" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        customer: { id: string; phone: string };
      };
      // The existing customer is returned, not a newly created one.
      expect(parsed.customer.id).toBe("cust-phone-001");
      expect(parsed.customer.phone).toBe("+541159999999");
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true on domain error (CUSTOMER_NOT_FOUND from update)", async () => {
    prismaTxMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
    updateCustomerInTransactionMock.mockRejectedValue(new Error("CUSTOMER_NOT_FOUND"));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "upsert_customer",
        arguments: { customerId: "cust-missing-999", name: "Nobody" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe("CUSTOMER_NOT_FOUND");
      expect(parsed.message).toContain("not found");
    } finally {
      await cleanup();
    }
  });

  it("passes businessId from closure to the mutation — never from tool input", async () => {
    const created = makeCustomerRow({ id: "cust-bizid-001", name: "Closure Test" });
    createCustomerInTransactionMock.mockResolvedValue(created);
    prismaTxMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "upsert_customer",
        arguments: { name: "Closure Test" },
      });
      expect(createCustomerInTransactionMock).toHaveBeenCalledWith(
        expect.anything(), // tx
        expect.objectContaining({ businessId: BUSINESS_ID }),
      );
    } finally {
      await cleanup();
    }
  });
});
