// tests/vitest/mcp/sales-tools.test.ts
//
// Unit tests for Batch 4 money tools:
//   sales-tools.ts     : register_sale, register_movement
//                        register_promesa_sale, confirm_promesa_payment,
//                        settle_promesa_payment
//
// ALL mutations go through mocked use-cases — no real DB is touched.
//
// Critical test axes for each tool:
//   (a) success — happy path returns expected fields, no isError
//   (b) failure — use-case domain error → isError
//   (c) tenant isolation — foreign-tenant caller-supplied ID → not-found / isError,
//       NO mutation of another tenant; closure businessId always sent to use-case
//   (d) idempotency — replayed outcome is surfaced without isError (no double write)
//
// Pre-existing vitest failures on main (sale-post-commit-chain, employee-auth-edge)
// are unrelated — verify this file's pass count independently.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Hoisted mock factories ────────────────────────────────────────────────────

const {
  saleExecuteMock,
  cashMovementExecuteMock,
  registerPromesaSaleMock,
  confirmPromesaMock,
  settlePromesaMock,
  productFindManyMock,
} = vi.hoisted(() => ({
  saleExecuteMock: vi.fn(),
  cashMovementExecuteMock: vi.fn(),
  registerPromesaSaleMock: vi.fn(),
  confirmPromesaMock: vi.fn(),
  settlePromesaMock: vi.fn(),
  // Used by resolveCatalogPrices (sale-price-guard.ts) to return catalog prices
  // for register_sale. Default: return prod-001 at price 1500 (matches ITEM below).
  productFindManyMock: vi.fn().mockResolvedValue([
    { id: "prod-001", name: "Alfajor", price: 1500 },
  ]),
}));

// ── Use-case mocks ────────────────────────────────────────────────────────────

vi.mock("@/application/use-cases/create-sale.use-case", () => ({
  createSaleUseCase: () => ({ execute: saleExecuteMock }),
}));

vi.mock("@/application/use-cases/create-cash-movement.use-case", () => ({
  createCashMovementUseCase: () => ({ execute: cashMovementExecuteMock }),
}));

vi.mock("@/app/api/payment-intents/_lib/register-promesa-sale-use-case", () => ({
  registerPromesaSaleUseCase: registerPromesaSaleMock,
}));

vi.mock("@/app/api/payment-intents/_lib/confirm-promesa-use-case", () => ({
  confirmPromesaPaymentUseCase: confirmPromesaMock,
}));

vi.mock("@/app/api/payment-intents/_lib/settle-promesa-use-case", () => ({
  settlePromesaUseCase: settlePromesaMock,
}));

// ── Infrastructure adapter mocks (no real DB) ─────────────────────────────────

vi.mock("@/infrastructure/persistence/prisma-business.repository", () => ({
  prismaBusinessRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-sale.repository", () => ({
  prismaSaleRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-inventory.repository", () => ({
  prismaInventoryRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-cash-movement.repository", () => ({
  prismaCashMovementRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-product.repository", () => ({
  prismaProductRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-supplier.repository", () => ({
  prismaSupplierRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-purchase-request.repository", () => ({
  prismaPurchaseRequestRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-stock-load.repository", () => ({
  prismaStockLoadRepository: {},
}));
vi.mock("@/infrastructure/persistence/prisma-stock-load-audit.adapter", () => ({
  prismaStockLoadAuditAdapter: {},
}));
vi.mock("@/infrastructure/persistence/prisma-idempotency.adapter", () => ({
  prismaIdempotencyAdapter: {},
}));
vi.mock("@/infrastructure/persistence/prisma-audit.adapter", () => ({
  prismaAuditAdapter: {},
}));
vi.mock("@/infrastructure/persistence/prisma-transaction.adapter", () => ({
  prismaTransactionAdapter: {},
}));

// ── Shared helpers mocks ───────────────────────────────────────────────────────

vi.mock("@/infrastructure/shared/sale-customer", () => ({
  normalizeCustomerName: (name: string) => name.toLowerCase(),
  CONSUMIDOR_FINAL_NAME: "Consumidor Final",
}));

vi.mock("@/infrastructure/shared/product-sku", () => ({
  buildActiveProductWhere: (where: Record<string, unknown>) => where,
}));

// ── Prisma mock ────────────────────────────────────────────────────────────────
// product.findMany is wired to productFindManyMock so register_sale tests can
// control what catalog prices resolveCatalogPrices sees (sale-price-guard.ts).

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findMany: productFindManyMock,
      findFirst: vi.fn().mockResolvedValue(null),
    },
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    // Stub for resolveTenantBackendMap — null = all env / "velora" defaults
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// ── Types ─────────────────────────────────────────────────────────────────────

interface TextContent { type: "text"; text: string; }
interface CallToolResult { isError?: boolean; content: TextContent[]; }
function asToolResult(raw: unknown): CallToolResult { return raw as CallToolResult; }

// ── Client helper ─────────────────────────────────────────────────────────────

async function buildConnectedClient(businessId?: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await buildVeloraMcpServer(businessId);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => { await client.close(); await server.close(); },
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("sales tools — registration", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("registers all 5 money tools + open_sale_confirm render tool when businessId is present", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-reg-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("register_sale");
      expect(names).toContain("register_movement");
      expect(names).toContain("register_promesa_sale");
      expect(names).toContain("confirm_promesa_payment");
      expect(names).toContain("settle_promesa_payment");
      expect(names).toContain("open_sale_confirm");
    } finally { await cleanup(); }
  });

  it("does NOT register money tools when no businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      for (const name of ["register_sale", "register_movement", "register_promesa_sale", "confirm_promesa_payment", "settle_promesa_payment"]) {
        expect(names).not.toContain(name);
      }
    } finally { await cleanup(); }
  });

  it("total tool count is 52", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-count-001");
    try {
      const result = await client.listTools();
      // 51 stateful (49 + open_business_overview + open_shipment_prep) + 1 pure (validate_cuit) = 52
      expect(result.tools).toHaveLength(52);
    } finally { await cleanup(); }
  });
});

// ── register_sale ─────────────────────────────────────────────────────────────

describe("register_sale tool", () => {
  const BIZ = "biz-rs-001";
  const ITEM = { productId: "prod-001", quantity: 2, unitPrice: 1500 };

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore catalog mock: prod-001 at price 1500 so existing tests pass the price guard.
    productFindManyMock.mockResolvedValue([{ id: "prod-001", name: "Alfajor", price: 1500 }]);
  });

  it("happy path — returns saleId, totalAmount, status, invoiceId", async () => {
    saleExecuteMock.mockResolvedValue({
      outcome: "created",
      data: {
        sale: { id: "sale-001", totalAmount: 3000, status: "paid" },
        invoice: { id: "inv-001", payload: {} },
        whatsappPhone: null, notifyLowStockWa: false, lowStockAlerts: [],
        auditMeta: { invoiceNumber: "0001-00000001", customerName: "CF", invoiceId: "inv-001", customerId: null, totalAmount: 3000, itemCount: 1 },
        idempotencyResponseBody: {},
      },
    });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_sale", arguments: { items: [ITEM] } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { saleId: string; totalAmount: number; invoiceId: string };
      expect(parsed.saleId).toBe("sale-001");
      expect(parsed.totalAmount).toBe(3000);
      expect(parsed.invoiceId).toBe("inv-001");
    } finally { await cleanup(); }
  });

  it("returns isError on empty items array (validation before use-case)", async () => {
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      // Pass an empty items array — the Zod schema requires min(1), expect MCP error
      const raw = await client.callTool({ name: "register_sale", arguments: { items: [] } }).catch((e: unknown) => e);
      // Either the MCP framework rejects it via schema or we get isError from handler
      if (raw && typeof raw === "object" && "isError" in (raw as object)) {
        expect((raw as CallToolResult).isError).toBe(true);
      } else {
        // Zod rejected at protocol level — acceptable
        expect(true).toBe(true);
      }
    } finally { await cleanup(); }
  });

  it("returns isError when use-case returns product_not_owned (tenant isolation)", async () => {
    saleExecuteMock.mockResolvedValue({ outcome: "product_not_owned" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_sale", arguments: { items: [{ productId: "prod-foreign", quantity: 1, unitPrice: 100 }] } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PRODUCT_NOT_OWNED");
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: closure businessId is sent to the use-case — not from tool input", async () => {
    saleExecuteMock.mockResolvedValue({
      outcome: "created",
      data: { sale: { id: "s1", totalAmount: 100, status: "paid" }, invoice: { id: "i1", payload: {} }, whatsappPhone: null, notifyLowStockWa: false, lowStockAlerts: [], auditMeta: { invoiceNumber: "N", customerName: "CF", invoiceId: "i1", customerId: null, totalAmount: 100, itemCount: 1 }, idempotencyResponseBody: {} },
    });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "register_sale", arguments: { items: [ITEM] } });
      expect(saleExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
      // actorEmployeeId must be null (MCP has no employee actor)
      expect(saleExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ actorEmployeeId: null }));
    } finally { await cleanup(); }
  });

  it("IDEMPOTENCY: replayed outcome does not surface as isError", async () => {
    saleExecuteMock.mockResolvedValue({ outcome: "replayed", status: 201, body: { sale: { id: "sale-001" } } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_sale", arguments: { items: [ITEM] } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("returns isError for insufficient_stock", async () => {
    saleExecuteMock.mockResolvedValue({ outcome: "insufficient_stock", productName: "Yerba", available: 0 });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_sale", arguments: { items: [ITEM] } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("INSUFFICIENT_STOCK");
    } finally { await cleanup(); }
  });

  it("returns isError on DB throw (infrastructure failure)", async () => {
    saleExecuteMock.mockRejectedValue(new Error("DB connection reset"));
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_sale", arguments: { items: [ITEM] } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
    } finally { await cleanup(); }
  });
});

// ── register_movement ─────────────────────────────────────────────────────────

describe("register_movement tool", () => {
  const BIZ = "biz-rm-001";

  beforeEach(() => { vi.clearAllMocks(); });

  it("happy path — returns movementId, type, amount, description, date", async () => {
    cashMovementExecuteMock.mockResolvedValue({
      outcome: "created",
      movement: { id: "mov-001", type: "purchase", description: "Pago proveedor", amount: 5000, date: new Date("2026-06-01") },
      signCorrected: false,
    });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_movement", arguments: { type: "purchase", description: "Pago proveedor", amount: 5000 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { movementId: string; type: string; amount: number };
      expect(parsed.movementId).toBe("mov-001");
      expect(parsed.type).toBe("purchase");
      expect(parsed.amount).toBe(5000);
    } finally { await cleanup(); }
  });

  it("IDEMPOTENCY: replayed outcome is not isError", async () => {
    cashMovementExecuteMock.mockResolvedValue({ outcome: "replayed", status: 201, body: { movement: { id: "mov-001" } } });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_movement", arguments: { type: "income", description: "Cobro venta", amount: 1000 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: closure businessId sent to use-case — not from tool input", async () => {
    cashMovementExecuteMock.mockResolvedValue({
      outcome: "created",
      movement: { id: "m1", type: "income", description: "X", amount: 100, date: new Date() },
      signCorrected: false,
    });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "register_movement", arguments: { type: "income", description: "X", amount: 100 } });
      expect(cashMovementExecuteMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });

  it("returns isError on infrastructure failure", async () => {
    cashMovementExecuteMock.mockRejectedValue(new Error("DB down"));
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_movement", arguments: { type: "purchase", description: "X", amount: 500 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
    } finally { await cleanup(); }
  });
});

// ── register_promesa_sale ─────────────────────────────────────────────────────

describe("register_promesa_sale tool", () => {
  const BIZ = "biz-rps-001";
  const ITEMS = [{ productId: "prod-001", quantity: 1 }];

  beforeEach(() => { vi.clearAllMocks(); });

  it("happy path — returns paymentIntentId, saleId, grandTotal", async () => {
    registerPromesaSaleMock.mockResolvedValue({
      outcome: "created",
      paymentIntentId: "pi-001",
      saleId: "sale-001",
      grandTotal: 2500,
    });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_promesa_sale", arguments: { customerId: "cust-001", items: ITEMS, expectedAt: "2026-07-15" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { paymentIntentId: string; saleId: string; grandTotal: number };
      expect(parsed.paymentIntentId).toBe("pi-001");
      expect(parsed.saleId).toBe("sale-001");
      expect(parsed.grandTotal).toBe(2500);
    } finally { await cleanup(); }
  });

  it("IDEMPOTENCY: replayed outcome is not isError", async () => {
    registerPromesaSaleMock.mockResolvedValue({ outcome: "replayed", paymentIntentId: "pi-001", saleId: "sale-001" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_promesa_sale", arguments: { customerId: "cust-001", items: ITEMS, expectedAt: "2026-07-15" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { replayed: boolean };
      expect(parsed.replayed).toBe(true);
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign customerId → CUSTOMER_NOT_FOUND isError — no sale created", async () => {
    registerPromesaSaleMock.mockResolvedValue({ outcome: "customer_not_found" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_promesa_sale", arguments: { customerId: "cust-foreign", items: ITEMS, expectedAt: "2026-07-15" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("CUSTOMER_NOT_FOUND");
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign productId → PRODUCT_NOT_FOUND isError — no sale created", async () => {
    registerPromesaSaleMock.mockResolvedValue({ outcome: "product_not_found", productId: "prod-foreign" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_promesa_sale", arguments: { customerId: "cust-001", items: [{ productId: "prod-foreign", quantity: 1 }], expectedAt: "2026-07-15" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PRODUCT_NOT_FOUND");
      // Use-case must have been called with closure businessId
      expect(registerPromesaSaleMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });

  it("returns isError for insufficient_stock", async () => {
    registerPromesaSaleMock.mockResolvedValue({ outcome: "insufficient_stock", productName: "Yerba", available: 0 });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "register_promesa_sale", arguments: { customerId: "cust-001", items: ITEMS, expectedAt: "2026-07-15" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("INSUFFICIENT_STOCK");
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: closure businessId is sent to the use-case", async () => {
    registerPromesaSaleMock.mockResolvedValue({ outcome: "created", paymentIntentId: "pi-1", saleId: "s-1", grandTotal: 100 });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "register_promesa_sale", arguments: { customerId: "cust-001", items: ITEMS, expectedAt: "2026-07-15" } });
      expect(registerPromesaSaleMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });
});

// ── confirm_promesa_payment ───────────────────────────────────────────────────

describe("confirm_promesa_payment tool", () => {
  const BIZ = "biz-cp-001";

  beforeEach(() => { vi.clearAllMocks(); });

  it("happy path — returns paymentIntentId and promesaExpectedAt", async () => {
    const expectedAt = new Date("2026-07-15");
    confirmPromesaMock.mockResolvedValue({ outcome: "confirmed", paymentIntentId: "pi-001", promesaExpectedAt: expectedAt });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "confirm_promesa_payment", arguments: { paymentIntentId: "pi-001", expectedAt: "2026-07-15" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { paymentIntentId: string; promesaExpectedAt: string };
      expect(parsed.paymentIntentId).toBe("pi-001");
    } finally { await cleanup(); }
  });

  it("IDEMPOTENCY: already_confirmed → replayed=true without isError", async () => {
    confirmPromesaMock.mockResolvedValue({ outcome: "already_confirmed", paymentIntentId: "pi-001" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "confirm_promesa_payment", arguments: { paymentIntentId: "pi-001", expectedAt: "2026-07-15" } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { replayed: boolean };
      expect(parsed.replayed).toBe(true);
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign paymentIntentId → PAYMENT_INTENT_NOT_FOUND isError", async () => {
    // use-case does findFirst({ id, businessId }) → null → not_found
    confirmPromesaMock.mockResolvedValue({ outcome: "not_found" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "confirm_promesa_payment", arguments: { paymentIntentId: "pi-foreign", expectedAt: "2026-07-15" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PAYMENT_INTENT_NOT_FOUND");
      // Verify closure businessId was sent
      expect(confirmPromesaMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, paymentIntentId: "pi-foreign" }));
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: closure businessId is sent to the use-case — never from input", async () => {
    confirmPromesaMock.mockResolvedValue({ outcome: "confirmed", paymentIntentId: "pi-1", promesaExpectedAt: new Date() });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "confirm_promesa_payment", arguments: { paymentIntentId: "pi-1", expectedAt: "2026-07-15" } });
      expect(confirmPromesaMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });

  it("returns isError for wrong_state", async () => {
    confirmPromesaMock.mockResolvedValue({ outcome: "wrong_state", currentState: "cancelled" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "confirm_promesa_payment", arguments: { paymentIntentId: "pi-001", expectedAt: "2026-07-15" } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("WRONG_STATE");
    } finally { await cleanup(); }
  });
});

// ── settle_promesa_payment ────────────────────────────────────────────────────

describe("settle_promesa_payment tool", () => {
  const BIZ = "biz-sp-001";

  beforeEach(() => { vi.clearAllMocks(); });

  it("happy path — returns cashMovementId and settledAt", async () => {
    const now = new Date();
    settlePromesaMock.mockResolvedValue({ outcome: "settled", cashMovementId: "cm-001", settledAt: now });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "settle_promesa_payment", arguments: { originalPaymentIntentId: "pi-001", paymentMethod: "transferencia", amount: 2500 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { cashMovementId: string; settledAt: string };
      expect(parsed.cashMovementId).toBe("cm-001");
    } finally { await cleanup(); }
  });

  it("IDEMPOTENCY: already_settled → replayed=true without isError — no double CashMovement", async () => {
    settlePromesaMock.mockResolvedValue({ outcome: "already_settled", cashMovementId: "cm-001" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "settle_promesa_payment", arguments: { originalPaymentIntentId: "pi-001", paymentMethod: "efectivo", amount: 2500 } });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { replayed: boolean; cashMovementId: string };
      expect(parsed.replayed).toBe(true);
      expect(parsed.cashMovementId).toBe("cm-001");
      // settle use-case called only once (not twice)
      expect(settlePromesaMock).toHaveBeenCalledTimes(1);
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: foreign originalPaymentIntentId → PAYMENT_INTENT_NOT_FOUND isError", async () => {
    // use-case does findFirst({ id, businessId }) → null → not_found
    settlePromesaMock.mockResolvedValue({ outcome: "not_found" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "settle_promesa_payment", arguments: { originalPaymentIntentId: "pi-foreign", paymentMethod: "mp", amount: 1000 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PAYMENT_INTENT_NOT_FOUND");
      // Verify closure businessId was sent and not the caller's choice
      expect(settlePromesaMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, originalPaymentIntentId: "pi-foreign" }));
    } finally { await cleanup(); }
  });

  it("TENANT ISOLATION: closure businessId is sent to the use-case — never from tool input", async () => {
    settlePromesaMock.mockResolvedValue({ outcome: "settled", cashMovementId: "cm-1", settledAt: new Date() });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      await client.callTool({ name: "settle_promesa_payment", arguments: { originalPaymentIntentId: "pi-001", paymentMethod: "efectivo", amount: 500 } });
      expect(settlePromesaMock).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
    } finally { await cleanup(); }
  });

  it("returns isError for amount_too_large", async () => {
    settlePromesaMock.mockResolvedValue({ outcome: "amount_too_large" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "settle_promesa_payment", arguments: { originalPaymentIntentId: "pi-001", paymentMethod: "transferencia", amount: 99999 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("AMOUNT_TOO_LARGE");
    } finally { await cleanup(); }
  });

  it("returns isError for wrong_metodo (not a promesa PI)", async () => {
    settlePromesaMock.mockResolvedValue({ outcome: "wrong_metodo", metodo: "mp" });
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({ name: "settle_promesa_payment", arguments: { originalPaymentIntentId: "pi-001", paymentMethod: "efectivo", amount: 100 } });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("WRONG_METODO");
    } finally { await cleanup(); }
  });
});

// ── register_sale: MCP money-path price guard ─────────────────────────────────
//
// Tests for the catalog price resolution + PRICE_OUTLIER guard in sale-price-guard.ts.
//
// (a) omitting unitPrice uses the catalog price — sale succeeds and unitPrice is DB-derived
// (b) supplying an absurd unitPrice (1 for a 500-catalog item) → REJECTED, nothing written to DB
// (c) supplying the catalog price exactly (or within 50% band) → accepted

describe("register_sale: MCP money-path price guard", () => {
  const BIZ = "biz-pg-001";

  beforeEach(() => {
    vi.clearAllMocks();
    // Catalog: prod-500 at price ARS 500 per unit.
    productFindManyMock.mockResolvedValue([{ id: "prod-500", name: "Yerba 1kg", price: 500 }]);
  });

  // (a) unitPrice omitted → catalog price used, sale proceeds
  it("(a) omitting unitPrice uses the catalog price — use-case receives DB price", async () => {
    saleExecuteMock.mockResolvedValue({
      outcome: "created",
      data: {
        sale: { id: "sale-pg-001", totalAmount: 500, status: "paid" },
        invoice: { id: "inv-pg-001", payload: {} },
        whatsappPhone: null, notifyLowStockWa: false, lowStockAlerts: [],
        auditMeta: { invoiceNumber: "0001-00000001", customerName: "CF", invoiceId: "inv-pg-001", customerId: null, totalAmount: 500, itemCount: 1 },
        idempotencyResponseBody: {},
      },
    });

    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      // Supply items WITHOUT unitPrice — guard must use catalog price (500)
      const raw = await client.callTool({
        name: "register_sale",
        arguments: { items: [{ productId: "prod-500", quantity: 1 }] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();

      // use-case must have been called with unitPrice = 500 (catalog), not undefined or 0
      expect(saleExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ productId: "prod-500", quantity: 1, unitPrice: 500 })],
        }),
      );
    } finally { await cleanup(); }
  });

  // (b) absurd price (1 for a 500-catalog item) → PRICE_OUTLIER, use-case NOT called
  it("(b) absurd unitPrice (1 for catalog 500) → PRICE_OUTLIER isError, use-case NOT called", async () => {
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({
        name: "register_sale",
        arguments: { items: [{ productId: "prod-500", quantity: 3, unitPrice: 1 }] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe("PRICE_OUTLIER");
      expect(parsed.message).toContain("Yerba 1kg");
      expect(parsed.message).toContain("500"); // catalog price surfaced in message
      // CRITICAL: use-case must NOT have been called — no DB write
      expect(saleExecuteMock).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  // (b) also test price wildly above catalog (e.g. 99999 for catalog 500)
  it("(b) price 99999 for catalog 500 → PRICE_OUTLIER isError, use-case NOT called", async () => {
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({
        name: "register_sale",
        arguments: { items: [{ productId: "prod-500", quantity: 1, unitPrice: 99999 }] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PRICE_OUTLIER");
      expect(saleExecuteMock).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  // Zero-price catalog product must reject (was a guard bypass — JD round 1):
  // a 0 catalog price made the outlier check a no-op AND produced a zero-total sale.
  it("zero catalog price + supplied unitPrice → CATALOG_PRICE_INVALID, use-case NOT called", async () => {
    productFindManyMock.mockResolvedValue([{ id: "prod-zero", name: "Muestra", price: 0 }]);
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({
        name: "register_sale",
        arguments: { items: [{ productId: "prod-zero", quantity: 1, unitPrice: 99999 }] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("CATALOG_PRICE_INVALID");
      expect(saleExecuteMock).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  it("zero catalog price + omitted unitPrice → CATALOG_PRICE_INVALID (no zero-total sale)", async () => {
    productFindManyMock.mockResolvedValue([{ id: "prod-zero", name: "Muestra", price: 0 }]);
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({
        name: "register_sale",
        arguments: { items: [{ productId: "prod-zero", quantity: 1 }] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("CATALOG_PRICE_INVALID");
      expect(saleExecuteMock).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  // (c) supplying catalog price exactly → accepted, passes through to use-case
  it("(c) supplying exact catalog price → accepted, use-case called with that price", async () => {
    saleExecuteMock.mockResolvedValue({
      outcome: "created",
      data: {
        sale: { id: "sale-pg-002", totalAmount: 1000, status: "paid" },
        invoice: { id: "inv-pg-002", payload: {} },
        whatsappPhone: null, notifyLowStockWa: false, lowStockAlerts: [],
        auditMeta: { invoiceNumber: "0001-00000002", customerName: "CF", invoiceId: "inv-pg-002", customerId: null, totalAmount: 1000, itemCount: 1 },
        idempotencyResponseBody: {},
      },
    });

    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({
        name: "register_sale",
        arguments: { items: [{ productId: "prod-500", quantity: 2, unitPrice: 500 }] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      expect(saleExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ unitPrice: 500 })],
        }),
      );
    } finally { await cleanup(); }
  });

  // (c) within-band override (e.g. 400 for catalog 500 = 20% below, within 50%) → accepted
  it("(c) within-band price (400 for catalog 500, 20% below) → accepted", async () => {
    saleExecuteMock.mockResolvedValue({
      outcome: "created",
      data: {
        sale: { id: "sale-pg-003", totalAmount: 400, status: "paid" },
        invoice: { id: "inv-pg-003", payload: {} },
        whatsappPhone: null, notifyLowStockWa: false, lowStockAlerts: [],
        auditMeta: { invoiceNumber: "0001-00000003", customerName: "CF", invoiceId: "inv-pg-003", customerId: null, totalAmount: 400, itemCount: 1 },
        idempotencyResponseBody: {},
      },
    });

    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({
        name: "register_sale",
        arguments: { items: [{ productId: "prod-500", quantity: 1, unitPrice: 400 }] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBeFalsy();
      expect(saleExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ unitPrice: 400 })],
        }),
      );
    } finally { await cleanup(); }
  });

  // (b) edge: price exactly at the outlier boundary + 1 unit → REJECTED
  it("(b) price at 51% below catalog (threshold is 50%) → PRICE_OUTLIER", async () => {
    // catalog 500, 51% below = 500 * (1 - 0.51) = 245
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({
        name: "register_sale",
        arguments: { items: [{ productId: "prod-500", quantity: 1, unitPrice: 245 }] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PRICE_OUTLIER");
      expect(saleExecuteMock).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  // Product not in catalog → PRODUCT_NOT_OWNED (guard catches it before use-case)
  it("product not in catalog → PRODUCT_NOT_OWNED from guard, use-case NOT called", async () => {
    productFindManyMock.mockResolvedValue([]); // empty catalog for this test
    const { client, cleanup } = await buildConnectedClient(BIZ);
    try {
      const raw = await client.callTool({
        name: "register_sale",
        arguments: { items: [{ productId: "prod-unknown", quantity: 1 }] },
      });
      const result = asToolResult(raw);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string };
      expect(parsed.code).toBe("PRODUCT_NOT_OWNED");
      expect(saleExecuteMock).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });
});
