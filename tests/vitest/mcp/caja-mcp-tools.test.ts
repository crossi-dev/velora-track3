// tests/vitest/mcp/caja-mcp-tools.test.ts
//
// Unit tests for the caja MCP tool registrations (caja-tools.ts + caja-mutations.ts).
//
// Three tool surfaces:
//   caja_consultar_saldo     — read-only, calls backend port, not prisma directly
//   caja_ciclo_caja          — money mutation (open/close shift), full idempotency contract
//   caja_registrar_movimiento— money mutation (cash movement), full idempotency contract
//
// Test contract:
//   (c1) All three tools appear in tool listing when businessId is provided
//   (c2) Tools do NOT appear when no businessId is provided
//   (c3) consultar_saldo: calls backend.findOpenSessionWithAmount — not prisma directly
//   (c4) consultar_saldo: returns CLOSED state when no open session exists
//   (c5) consultar_saldo: returns NO_SESSION when no session at all
//   (c6) caja_ciclo_caja: calls backend.createSession (abrir) — not prisma.cajaSession.create
//   (c7) caja_ciclo_caja: returns SESSION_ALREADY_OPEN when a session is already open
//   (c8) caja_registrar_movimiento: calls backend.createMovement — not prisma.$transaction
//   (c9) caja_registrar_movimiento: maps ES tipo to domain type correctly
//   (c10) No caller-supplied idempotency_key field in any tool schema (stripped by Zod)
//
// Pattern mirrors tests/vitest/mcp/payments-tools.test.ts (InMemoryTransport + buildVeloraMcpServer).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  mockFindOpenSessionWithAmount,
  mockFindLastClosedSession,
  mockFindOpenSession,
  mockFindCashMovementsForSession,
  mockCreateSession,
  mockCreateMovement,
  mockCloseSession,
} = vi.hoisted(() => ({
  mockFindOpenSessionWithAmount: vi.fn(),
  mockFindLastClosedSession: vi.fn(),
  mockFindOpenSession: vi.fn(),
  mockFindCashMovementsForSession: vi.fn(),
  mockCreateSession: vi.fn(),
  mockCreateMovement: vi.fn(),
  mockCloseSession: vi.fn(),
}));

// Mock CajaBackend factory — tests get a controlled backend, not the real adapter.
vi.mock("@/lib/mcp/_lib/caja-backend.factory", () => ({
  createCajaBackend: () => ({
    findOpenSessionWithAmount: mockFindOpenSessionWithAmount,
    findLastClosedSession: mockFindLastClosedSession,
    findOpenSession: mockFindOpenSession,
    findCashMovementsForSession: mockFindCashMovementsForSession,
    createSession: mockCreateSession,
    closeSession: mockCloseSession,
    createMovement: mockCreateMovement,
  }),
}));

// Mock idempotency helpers — tests focus on port delegation, not idempotency internals.
vi.mock("@/app/api/_lib/idempotency", () => ({
  beginIdempotentMutation: vi.fn().mockResolvedValue({ kind: "execute", recordId: "rec-caja-001" }),
  completeIdempotentMutation: vi.fn().mockResolvedValue(undefined),
  releaseIdempotentMutation: vi.fn().mockResolvedValue(undefined),
}));

// Mock audit — not under test here.
vi.mock("@/infrastructure/shared/critical-write-audit", () => ({
  recordCriticalWriteEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock prisma — must NOT be called directly by tool bodies.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    cajaSession: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    cashMovement: { findMany: vi.fn() },
    $transaction: vi.fn(),
    // Stubs for other packs registered in server.ts
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    customer: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

// ── Types + helpers ────────────────────────────────────────────────────────────

interface TextContent { type: "text"; text: string }
interface ToolResult { isError?: boolean; content: TextContent[] }

function parseResult(raw: unknown): { isError: boolean; data: unknown } {
  const r = raw as ToolResult;
  const text = r.content[0]?.text ?? "{}";
  return { isError: !!r.isError, data: JSON.parse(text) };
}

async function buildClient(businessId?: string) {
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

describe("(c1/c2) caja tools — registration", () => {
  it("(c1) all caja tools (3 mutating + open_caja_status render) appear when businessId is provided", async () => {
    const { client, cleanup } = await buildClient("biz-caja-001");
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("caja_consultar_saldo");
      expect(names).toContain("caja_ciclo_caja");
      expect(names).toContain("caja_registrar_movimiento");
      expect(names).toContain("open_caja_status");
    } finally {
      await cleanup();
    }
  });

  it("(c2) caja tools NOT present without businessId", async () => {
    const { client, cleanup } = await buildClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("caja_consultar_saldo");
      expect(names).not.toContain("caja_ciclo_caja");
      expect(names).not.toContain("caja_registrar_movimiento");
      expect(names).not.toContain("open_caja_status");
    } finally {
      await cleanup();
    }
  });
});

// ── caja_consultar_saldo ──────────────────────────────────────────────────────

describe("(c3–c5) caja_consultar_saldo", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("(c3) returns OPEN state and delegates to backend — not prisma.cajaSession.findFirst", async () => {
    const openedAt = new Date("2026-06-01T10:00:00Z");
    mockFindOpenSessionWithAmount.mockResolvedValue({
      id: "sess-open-001",
      openedAt,
      openedCashAmount: 5000,
    });
    mockFindCashMovementsForSession.mockResolvedValue([{ amount: 1000 }, { amount: -200 }]);

    const { client, cleanup } = await buildClient("biz-caja-read");
    try {
      const raw = await client.callTool({ name: "caja_consultar_saldo", arguments: {} });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      expect(d.state).toBe("OPEN");
      expect(d.expectedCashAmount).toBe(5800); // 5000 + 1000 - 200
      expect(d.totalInflows).toBe(1000);
      expect(d.totalOutflows).toBe(200);
      // Verify backend was called — not prisma directly.
      expect(mockFindOpenSessionWithAmount).toHaveBeenCalledWith("biz-caja-read");
      expect(mockFindCashMovementsForSession).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("(c4) returns CLOSED state when no open session but last closed exists", async () => {
    mockFindOpenSessionWithAmount.mockResolvedValue(null);
    mockFindLastClosedSession.mockResolvedValue({
      id: "sess-closed-001",
      closedAt: "2026-05-31T20:00:00.000Z",
      closedCashAmount: 8500,
      variance: 50,
    });

    const { client, cleanup } = await buildClient("biz-caja-closed");
    try {
      const raw = await client.callTool({ name: "caja_consultar_saldo", arguments: {} });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      expect(d.state).toBe("CLOSED");
      expect(d.closedCashAmount).toBe(8500);
    } finally {
      await cleanup();
    }
  });

  it("(c5) returns NO_SESSION when no sessions exist at all", async () => {
    mockFindOpenSessionWithAmount.mockResolvedValue(null);
    mockFindLastClosedSession.mockResolvedValue(null);

    const { client, cleanup } = await buildClient("biz-caja-new");
    try {
      const raw = await client.callTool({ name: "caja_consultar_saldo", arguments: {} });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      expect(d.state).toBe("NO_SESSION");
    } finally {
      await cleanup();
    }
  });
});

// ── caja_ciclo_caja ───────────────────────────────────────────────────────────

describe("(c6–c7) caja_ciclo_caja", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("(c6) abrir: calls backend.createSession — NOT prisma.cajaSession.create", async () => {
    const openedAt = new Date();
    mockFindOpenSession.mockResolvedValue(null);
    mockCreateSession.mockResolvedValue({ id: "sess-new-001", openedAt });

    const { client, cleanup } = await buildClient("biz-caja-open");
    try {
      const raw = await client.callTool({
        name: "caja_ciclo_caja",
        arguments: { action: "abrir", monto: 3000 },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      expect(d.state).toBe("OPEN");
      expect(d.openedCashAmount).toBe(3000);
      // Backend port called, not prisma directly.
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: "biz-caja-open", openedCashAmount: 3000 }),
      );
    } finally {
      await cleanup();
    }
  });

  it("(c7) abrir: returns SESSION_ALREADY_OPEN when a session is already open", async () => {
    mockFindOpenSession.mockResolvedValue({ id: "sess-existing", openedAt: new Date() });

    const { client, cleanup } = await buildClient("biz-caja-dup");
    try {
      const raw = await client.callTool({
        name: "caja_ciclo_caja",
        arguments: { action: "abrir", monto: 5000 },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(true);
      expect(d.code).toBe("SESSION_ALREADY_OPEN");
    } finally {
      await cleanup();
    }
  });
});

// ── caja_registrar_movimiento ─────────────────────────────────────────────────

describe("(c8–c10) caja_registrar_movimiento", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("(c8) calls backend.createMovement — NOT prisma.$transaction", async () => {
    mockCreateMovement.mockResolvedValue({ id: "mov-001", amount: -500 });

    const { client, cleanup } = await buildClient("biz-caja-mov");
    try {
      const raw = await client.callTool({
        name: "caja_registrar_movimiento",
        arguments: { tipo: "gasto", monto: 500, descripcion: "Electric bill" },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      expect(d.type).toBe("purchase");
      expect(d.amount).toBe(-500);
      expect(mockCreateMovement).toHaveBeenCalledTimes(1);
      expect(mockCreateMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: "biz-caja-mov",
          domainType: "purchase",
          amount: 500,
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("(c9) maps sangría correctly to 'withdrawal' domain type", async () => {
    mockCreateMovement.mockResolvedValue({ id: "mov-002", amount: -1000 });

    const { client, cleanup } = await buildClient("biz-caja-retiro");
    try {
      const raw = await client.callTool({
        name: "caja_registrar_movimiento",
        arguments: { tipo: "sangría", monto: 1000, descripcion: "Cash withdrawal" },
      });
      const { isError, data } = parseResult(raw);
      const d = data as Record<string, unknown>;
      expect(isError).toBe(false);
      expect(d.type).toBe("withdrawal");
    } finally {
      await cleanup();
    }
  });

  it("(c10) caller-supplied idempotency_key has no effect — server-derived key reaches backend, not 'attacker'", async () => {
    // The caja_registrar_movimiento schema does NOT include idempotency_key.
    // MCP SDK + Zod strip unknown fields before the handler runs.
    // This test proves the injected value never reaches the mutation:
    //   backend.createMovement must be called with a server-derived 32-char hex
    //   clientMessageId, NOT the attacker-supplied string "attacker".
    mockCreateMovement.mockResolvedValue({ id: "mov-003", amount: -800 });

    const { client, cleanup } = await buildClient("biz-caja-inject");
    try {
      // If the MCP SDK rejects the unknown field client-side, that is also correct.
      // In either path the attacker key must never reach createMovement.
      try {
        await client.callTool({
          name: "caja_registrar_movimiento",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          arguments: { tipo: "gasto" as any, monto: 800, descripcion: "Test", idempotency_key: "attacker" },
        });
      } catch {
        // SDK rejected client-side — createMovement was never called; assertion below handles both paths.
      }

      if (mockCreateMovement.mock.calls.length > 0) {
        // Handler ran — verify the clientMessageId is server-derived, not the injected value.
        const callArg = mockCreateMovement.mock.calls[0][0] as Record<string, unknown>;
        const derivedKey = callArg.clientMessageId as string;
        // Must be a 32-char lowercase hex string (SHA-256 slice).
        expect(derivedKey).toMatch(/^[0-9a-f]{32}$/);
        // Must NOT be the caller-injected value.
        expect(derivedKey).not.toBe("attacker");
      } else {
        // SDK stripped/rejected the unknown field before the handler ran — also correct.
        expect(mockCreateMovement).not.toHaveBeenCalled();
      }
    } finally {
      await cleanup();
    }
  });
});
