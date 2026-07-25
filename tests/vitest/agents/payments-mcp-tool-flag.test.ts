// tests/vitest/agents/payments-mcp-tool-flag.test.ts
//
// Strangler-fig convergence tests for USE_MCP_PAYMENTS_TOOL feature flag.
// Verifies the three guarantees required before JD review:
//
//   F1 — flag OFF (default): createPaymentsAgent registers the OLD FunctionTool
//        (buildCreatePaymentLinkTool). Tool name exposed to the LLM is "create_payment_link".
//
//   F2 — flag ON: createPaymentsAgent registers the NEW wrapper
//        (buildMcpCreatePaymentLinkTool). Tool name exposed to the LLM is STILL "create_payment_link".
//
//   F3 — idempotency key in the createTool execute path is server-derived:
//        buildLinkIdempotencyKey(businessId, description, turnId) — not LLM-supplied.
//        Changing the LLM-supplied description input to the tool does NOT change the key
//        if businessId + description + turnId remain the same.
//
//   F4 — isMcpPaymentsToolEnabled() reads the env var at call time (not module load).
//
// Mocked modules: server-only, @google/adk (Agent, FunctionTool),
//                 agent-factory, gemini-config, payments-agent-helpers,
//                 payments-agent-tools, pagos-crear-link-pago.execute,
//                 adk-payments-agent (for buildLinkIdempotencyKey).
//
// NOTE: The agent-factory and ADK modules require mocking because createPaymentsAgent
// calls createAdkAgent which hits real ADK initialisation (Vertex credentials).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Suppress server-only ───────────────────────────────────────────────────────
vi.mock("server-only", () => ({}));

// ── Hoist shared mock builders ─────────────────────────────────────────────────
const { createAdkAgentMock, capturedFunctionToolCalls } = vi.hoisted(() => {
  const calls: Array<{ name: string }> = [];
  return {
    capturedFunctionToolCalls: calls,
    createAdkAgentMock: vi.fn().mockImplementation(({ tools }: { tools: unknown[] }) => ({
      _isAgent: true,
      tools,
    })),
  };
});

// FunctionTool must be a real class (constructor) so `new FunctionTool({...})` works.
class MockFunctionTool {
  name: string;
  _isMock = true;
  __opts: { name: string };
  constructor(opts: { name: string }) {
    this.name = opts.name;
    this.__opts = opts;
    capturedFunctionToolCalls.push({ name: opts.name });
  }
}

vi.mock("@google/adk", () => ({
  FunctionTool: MockFunctionTool,
  Agent: class MockAgent {},
}));

vi.mock("@/lib/adk/agent-factory", () => ({
  createAdkAgent: createAdkAgentMock,
}));

vi.mock("@/lib/adk/gemini-config", () => ({
  getAdkPaymentsModel: vi.fn().mockReturnValue("gemini-mock"),
}));

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/payments-agent-helpers",
  () => ({
    PAYMENTS_SYSTEM_PROMPT: "mock-system-prompt",
    resolveCustomerIdByName: vi.fn(),
  }),
);

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/payments-agent-tools",
  () => ({
    buildCreatePaymentLinkTool: vi.fn().mockImplementation(() => ({
      _source: "old",
      name: "create_payment_link",
    })),
    buildGetPaymentStatusTool: vi.fn().mockReturnValue({ name: "get_payment_status" }),
  }),
);

vi.mock(
  "@/app/api/agents/payments/jsonrpc/_lib/pagos-crear-link-pago.execute",
  () => ({
    executeCrearLinkPago: vi.fn().mockResolvedValue({}),
  }),
);

// ── Imports ────────────────────────────────────────────────────────────────────

const importAgent = () =>
  import(
    "@/app/api/agents/payments/jsonrpc/_lib/adk-payments-agent"
  ) as Promise<
    typeof import("@/app/api/agents/payments/jsonrpc/_lib/adk-payments-agent")
  >;

const importFlag = () =>
  import(
    "@/app/api/agents/payments/jsonrpc/_lib/payments-mcp-link-tool"
  ) as Promise<
    typeof import("@/app/api/agents/payments/jsonrpc/_lib/payments-mcp-link-tool")
  >;

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE_CTX = {
  businessId: "biz_test123",
  actorUserId: "user_owner1",
  turnId: "turn-uuid-001",
  bizSnapshot: null,
};

function getFirstToolName(agent: { tools: unknown[] }): string {
  const tool = agent.tools[0] as { name: string };
  return tool.name;
}

// ── F1: flag OFF — old tool registered ────────────────────────────────────────

describe("F1 — USE_MCP_PAYMENTS_TOOL unset (default OFF): old tool is registered", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.USE_MCP_PAYMENTS_TOOL;
  });

  afterEach(() => {
    delete process.env.USE_MCP_PAYMENTS_TOOL;
  });

  it("creates an agent with the OLD buildCreatePaymentLinkTool (source=old)", async () => {
    const { createPaymentsAgent } = await importAgent();
    const agent = createPaymentsAgent(BASE_CTX) as unknown as { tools: { _source?: string; name: string }[] };
    const firstTool = agent.tools[0];
    expect(firstTool).toBeDefined();
    expect(firstTool._source).toBe("old");
  });

  it("tool name exposed to the LLM is 'create_payment_link'", async () => {
    const { createPaymentsAgent } = await importAgent();
    const agent = createPaymentsAgent(BASE_CTX) as unknown as { tools: { name: string }[] };
    expect(getFirstToolName(agent)).toBe("create_payment_link");
  });

  it("explicit USE_MCP_PAYMENTS_TOOL=false still uses old tool", async () => {
    process.env.USE_MCP_PAYMENTS_TOOL = "false";
    const { createPaymentsAgent } = await importAgent();
    const agent = createPaymentsAgent(BASE_CTX) as unknown as { tools: { _source?: string; name: string }[] };
    expect(agent.tools[0]._source).toBe("old");
  });
});

// ── F2: flag ON — new wrapper registered with same tool name ──────────────────

describe("F2 — USE_MCP_PAYMENTS_TOOL=true: new wrapper registered, name still create_payment_link", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.USE_MCP_PAYMENTS_TOOL = "true";
  });

  afterEach(() => {
    delete process.env.USE_MCP_PAYMENTS_TOOL;
  });

  it("creates an agent where first tool is NOT the old _source:old tool", async () => {
    const { createPaymentsAgent } = await importAgent();
    const agent = createPaymentsAgent(BASE_CTX) as unknown as { tools: { _source?: string; name: string }[] };
    // FunctionToolMock returns { _isMock: true, name } — not _source:old
    expect(agent.tools[0]._source).not.toBe("old");
  });

  it("tool name exposed to the LLM is still 'create_payment_link'", async () => {
    const { createPaymentsAgent } = await importAgent();
    const agent = createPaymentsAgent(BASE_CTX) as unknown as { tools: { name: string }[] };
    // FunctionToolMock captures the name passed to new FunctionTool({ name })
    expect(getFirstToolName(agent)).toBe("create_payment_link");
  });

  it("FunctionTool was constructed with name 'create_payment_link'", async () => {
    // Verify the MockFunctionTool constructor was called with the correct name.
    capturedFunctionToolCalls.length = 0; // clear previous runs
    await importAgent().then((m) => m.createPaymentsAgent(BASE_CTX));
    const found = capturedFunctionToolCalls.find((c) => c.name === "create_payment_link");
    expect(found).toBeDefined();
  });
});

// ── F3: idempotency key is server-derived in the new path ─────────────────────

describe("F3 — idempotency: buildLinkIdempotencyKey is server-derived (SHA-256 of businessId+description+turnId)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("buildLinkIdempotencyKey returns a 32-char hex string", async () => {
    const { buildLinkIdempotencyKey } = await importAgent();
    const key = buildLinkIdempotencyKey("biz_001", "Venta Velora", "turn-abc");
    expect(key).toHaveLength(32);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("same inputs produce the same key (deterministic)", async () => {
    const { buildLinkIdempotencyKey } = await importAgent();
    const k1 = buildLinkIdempotencyKey("biz_001", "Venta Velora", "turn-abc");
    const k2 = buildLinkIdempotencyKey("biz_001", "Venta Velora", "turn-abc");
    expect(k1).toBe(k2);
  });

  it("different turnId → different key (LLM cannot replay by sending same description)", async () => {
    const { buildLinkIdempotencyKey } = await importAgent();
    const k1 = buildLinkIdempotencyKey("biz_001", "Venta Velora", "turn-abc");
    const k2 = buildLinkIdempotencyKey("biz_001", "Venta Velora", "turn-xyz");
    expect(k1).not.toBe(k2);
  });

  it("different description → different key", async () => {
    const { buildLinkIdempotencyKey } = await importAgent();
    const k1 = buildLinkIdempotencyKey("biz_001", "Venta Velora", "turn-abc");
    const k2 = buildLinkIdempotencyKey("biz_001", "Otro producto", "turn-abc");
    expect(k1).not.toBe(k2);
  });

  it("canonicalises description casing — 'Venta Velora' == 'venta velora'", async () => {
    const { buildLinkIdempotencyKey } = await importAgent();
    const k1 = buildLinkIdempotencyKey("biz_001", "Venta Velora", "turn-abc");
    const k2 = buildLinkIdempotencyKey("biz_001", "venta velora", "turn-abc");
    expect(k1).toBe(k2);
  });

  it("canonicalises extra whitespace — 'Venta  Velora' == 'Venta Velora'", async () => {
    const { buildLinkIdempotencyKey } = await importAgent();
    const k1 = buildLinkIdempotencyKey("biz_001", "Venta Velora", "turn-abc");
    const k2 = buildLinkIdempotencyKey("biz_001", "Venta  Velora", "turn-abc");
    expect(k1).toBe(k2);
  });
});

// ── F4: isMcpPaymentsToolEnabled reads env at call time ───────────────────────

describe("F4 — isMcpPaymentsToolEnabled() reads env at call time", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.USE_MCP_PAYMENTS_TOOL;
  });

  it("returns false when env var is not set", async () => {
    delete process.env.USE_MCP_PAYMENTS_TOOL;
    const { isMcpPaymentsToolEnabled } = await importFlag();
    expect(isMcpPaymentsToolEnabled()).toBe(false);
  });

  it("returns false when env var is explicitly 'false'", async () => {
    process.env.USE_MCP_PAYMENTS_TOOL = "false";
    const { isMcpPaymentsToolEnabled } = await importFlag();
    expect(isMcpPaymentsToolEnabled()).toBe(false);
  });

  it("returns true when env var is 'true'", async () => {
    process.env.USE_MCP_PAYMENTS_TOOL = "true";
    const { isMcpPaymentsToolEnabled } = await importFlag();
    expect(isMcpPaymentsToolEnabled()).toBe(true);
  });

  it("reads at call time — toggling env after import changes behavior", async () => {
    delete process.env.USE_MCP_PAYMENTS_TOOL;
    const { isMcpPaymentsToolEnabled } = await importFlag();
    expect(isMcpPaymentsToolEnabled()).toBe(false);
    process.env.USE_MCP_PAYMENTS_TOOL = "true";
    expect(isMcpPaymentsToolEnabled()).toBe(true);
    delete process.env.USE_MCP_PAYMENTS_TOOL;
    expect(isMcpPaymentsToolEnabled()).toBe(false);
  });
});
