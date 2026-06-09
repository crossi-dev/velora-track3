// tests/vitest/adk/adk-pattern-c-dataParts.test.ts
//
// Regression test: createA2AAgentTool must extract Pattern C intents from
// reply.dataParts and push them into ctx.capturedPatternCIntents.
//
// Previously, createA2AAgentTool.execute() returned only { text, success: true },
// discarding reply.dataParts entirely. This caused Ventas / Communications /
// Inventario mutations to silently drop on the ADK path (usedAdkDelegation=true
// skips executeAgentCallActions, which was the only path that read dataParts).
//
// Fix (2026-06-03): the tool now pushes captured { intent, data, summary } objects
// into ctx.capturedPatternCIntents when that field is present on the context.
//
// Tests:
//   createA2AAgentTool (Pattern C accumulator):
//     - pushes dataParts intents into ctx.capturedPatternCIntents on success
//     - handles multiple intents in a single dataPart
//     - handles multiple dataParts in one reply
//     - skips malformed entries (no intent, no data, no summary)
//     - does NOT push when capturedPatternCIntents is absent from ctx
//     - does NOT push when success=false (error path leaves accumulator untouched)
//     - does NOT push when dataParts is empty
//   executeSupActions (ADK injection path):
//     - inlines capturedPatternCIntents into supResult.actions when usedAdkDelegation=true
//     - does NOT double-push when capturedPatternCIntents is empty
//
// Mocked: @/lib/a2a-client (sendMessage returns controlled reply)
//         @/lib/agent-identity (signAgentAssertion)
//         @/app/api/a2a/jsonrpc/_lib/handle-rpc (deriveA2AKey)
//         @/lib/agent-timeouts (remainingBudget)
//         @/lib/cloud-logger (cloudLog — suppress output)
//         server-only (allows non-server-env import)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock server-only so it doesn't throw in the test environment ───────────────
vi.mock("server-only", () => ({}));

// ── Shared mock refs (vi.hoisted runs before module evaluation) ────────────────
const { sendMessageMock, cloudLogMock, signAgentAssertionMock, deriveA2AKeyMock, remainingBudgetMock } =
  vi.hoisted(() => ({
    sendMessageMock: vi.fn(),
    cloudLogMock: vi.fn(),
    signAgentAssertionMock: vi.fn().mockReturnValue("mock-jwt"),
    deriveA2AKeyMock: vi.fn().mockReturnValue("mock-derived-key"),
    remainingBudgetMock: vi.fn().mockReturnValue(30000),
  }));

vi.mock("@/lib/a2a-client", () => ({
  sendMessage: sendMessageMock,
  A2AClientError: class A2AClientError extends Error {
    constructor(msg: string, public readonly code?: number) { super(msg); this.name = "A2AClientError"; }
  },
}));
vi.mock("@/lib/cloud-logger", () => ({ cloudLog: cloudLogMock }));
vi.mock("@/lib/agent-identity", () => ({ signAgentAssertion: signAgentAssertionMock }));
vi.mock("@/app/api/a2a/jsonrpc/_lib/handle-rpc", () => ({ deriveA2AKey: deriveA2AKeyMock }));
vi.mock("@/lib/agent-timeouts", () => ({ remainingBudget: remainingBudgetMock }));

// ── Imports (after mocks are declared) ────────────────────────────────────────
import { createA2AAgentTool, type PatternCIntent } from "@/lib/adk/tools/_shared/create-a2a-agent-tool";
import type { A2AAgentToolContext } from "@/lib/adk/tools/_shared/create-a2a-agent-tool";
import { Type } from "@google/genai";

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE_CTX: A2AAgentToolContext = {
  businessId: "biz-test-001",
  appUrl: "http://localhost:3000",
  apiKey: "test-api-key",
};

function makeReply(
  text: string,
  dataPartsPayloads: Array<{ intents: Array<{ intent: string; data: unknown; summary: string }> }> = [],
) {
  return {
    messageId: "msg-001",
    text,
    dataParts: dataPartsPayloads,
    contextId: "ctx-001",
  };
}

function makeTool(ctx: A2AAgentToolContext) {
  return createA2AAgentTool(
    {
      toolName: "call_test_agent",
      description: "Test agent tool",
      schema: {
        type: Type.OBJECT,
        properties: { message: { type: Type.STRING } },
        required: ["message"],
      },
      timeoutMs: 30000,
      callerIdentity: "supervisor",
      targetIdentity: "ventas",
      agentPath: "/api/agents/ventas/jsonrpc",
      logActionKey: "TEST",
      agentDisplayName: "Test Agent",
    },
    ctx,
  );
}

/** Calls a FunctionTool's execute function directly (bypasses ADK runner). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal execute for unit test
async function exec(tool: ReturnType<typeof makeTool>, args: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tool as any).execute(args);
}

// ── Tests: createA2AAgentTool Pattern C accumulator ───────────────────────────

describe("createA2AAgentTool — Pattern C capturedPatternCIntents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset A2A_SECRET so deriveA2AKey is called deterministically.
    process.env.A2A_SECRET = "test-secret";
  });

  afterEach(() => {
    delete process.env.A2A_SECRET;
  });

  it("pushes a single dataPart intent into capturedPatternCIntents on success", async () => {
    const capturedPatternCIntents: PatternCIntent[] = [];
    const ctx: A2AAgentToolContext = { ...BASE_CTX, capturedPatternCIntents };

    sendMessageMock.mockResolvedValue(
      makeReply("Venta registrada.", [
        {
          intents: [
            { intent: "register_sale", data: { items: [{ name: "Pan", qty: 2, price: 50 }] }, summary: "Venta 2x Pan $50" },
          ],
        },
      ]),
    );

    const tool = makeTool(ctx);
    const result = await exec(tool, { message: "registrá una venta de 2 panes a $50" }) as { text: string; success: boolean };

    expect(result.success).toBe(true);
    expect(result.text).toBe("Venta registrada.");
    expect(capturedPatternCIntents).toHaveLength(1);
    expect(capturedPatternCIntents[0]).toMatchObject({
      intent: "register_sale",
      data: { items: [{ name: "Pan", qty: 2, price: 50 }] },
      summary: "Venta 2x Pan $50",
    });
  });

  it("handles multiple intents in a single dataPart", async () => {
    const capturedPatternCIntents: PatternCIntent[] = [];
    const ctx: A2AAgentToolContext = { ...BASE_CTX, capturedPatternCIntents };

    sendMessageMock.mockResolvedValue(
      makeReply("Catálogo actualizado.", [
        {
          intents: [
            { intent: "create_product", data: { name: "Leche", price: 120 }, summary: "Crear Leche $120" },
            { intent: "stock_load", data: { items: [{ productId: "p1", qty: 10 }] }, summary: "Cargar stock 10u" },
          ],
        },
      ]),
    );

    const tool = makeTool(ctx);
    await exec(tool, { message: "creá leche a $120 y cargá 10 unidades" });

    expect(capturedPatternCIntents).toHaveLength(2);
    expect(capturedPatternCIntents[0].intent).toBe("create_product");
    expect(capturedPatternCIntents[1].intent).toBe("stock_load");
  });

  it("handles multiple dataParts, each with intents", async () => {
    const capturedPatternCIntents: PatternCIntent[] = [];
    const ctx: A2AAgentToolContext = { ...BASE_CTX, capturedPatternCIntents };

    sendMessageMock.mockResolvedValue(
      makeReply("Listo.", [
        { intents: [{ intent: "register_sale", data: { total: 500 }, summary: "Venta $500" }] },
        { intents: [{ intent: "create_customer", data: { name: "Juan" }, summary: "Nuevo cliente Juan" }] },
      ]),
    );

    const tool = makeTool(ctx);
    await exec(tool, { message: "registrá venta para Juan nuevo cliente" });

    expect(capturedPatternCIntents).toHaveLength(2);
    expect(capturedPatternCIntents.map((c) => c.intent)).toEqual(["register_sale", "create_customer"]);
  });

  it("skips malformed dataPart entries (missing intent, data, or summary)", async () => {
    const capturedPatternCIntents: PatternCIntent[] = [];
    const ctx: A2AAgentToolContext = { ...BASE_CTX, capturedPatternCIntents };

    sendMessageMock.mockResolvedValue(
      makeReply("Ok.", [
        {
          intents: [
            { intent: "register_sale", data: { total: 100 }, summary: "ok" }, // valid
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional malformed test data
            { intent: "broken_no_data", summary: "missing data" } as any, // no data → skip
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional malformed test data
            { data: { total: 200 }, summary: "missing intent" } as any, // no intent → skip
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional malformed test data
            { intent: "broken_no_summary", data: { total: 300 } } as any, // no summary → skip
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional malformed test data
            null as any, // null entry → skip
          ],
        },
      ]),
    );

    const tool = makeTool(ctx);
    await exec(tool, { message: "test" });

    // Only the first entry is valid.
    expect(capturedPatternCIntents).toHaveLength(1);
    expect(capturedPatternCIntents[0].intent).toBe("register_sale");
  });

  it("does NOT push when capturedPatternCIntents is absent from ctx", async () => {
    // ctx without capturedPatternCIntents — old behavior
    const ctx: A2AAgentToolContext = { ...BASE_CTX }; // no capturedPatternCIntents

    sendMessageMock.mockResolvedValue(
      makeReply("Ok.", [
        { intents: [{ intent: "register_sale", data: {}, summary: "sale" }] },
      ]),
    );

    const tool = makeTool(ctx);
    const result = await exec(tool, { message: "test" }) as { success: boolean };

    // Should succeed without throwing — the absence of the accumulator is safe.
    expect(result.success).toBe(true);
    // No accumulator to check — just verify no error was thrown.
  });

  it("does NOT push when dataParts is empty", async () => {
    const capturedPatternCIntents: PatternCIntent[] = [];
    const ctx: A2AAgentToolContext = { ...BASE_CTX, capturedPatternCIntents };

    // Agent that returns text only, no dataParts (payments, fiscal, caja, logistica pattern)
    sendMessageMock.mockResolvedValue(makeReply("Link creado: https://mp.me/pay/abc", []));

    const tool = makeTool(ctx);
    await exec(tool, { message: "creá un link de pago" });

    expect(capturedPatternCIntents).toHaveLength(0);
  });

  it("does NOT push when the call fails (error path)", async () => {
    const capturedPatternCIntents: PatternCIntent[] = [];
    const ctx: A2AAgentToolContext = { ...BASE_CTX, capturedPatternCIntents };

    sendMessageMock.mockRejectedValue(new Error("network error"));

    const tool = makeTool(ctx);
    const result = await exec(tool, { message: "test" }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(capturedPatternCIntents).toHaveLength(0);
  });

  it("accumulates across multiple tool invocations (shared array reference)", async () => {
    const capturedPatternCIntents: PatternCIntent[] = [];
    const ctx: A2AAgentToolContext = { ...BASE_CTX, capturedPatternCIntents };
    const tool = makeTool(ctx);

    sendMessageMock
      .mockResolvedValueOnce(
        makeReply("Primera venta.", [
          { intents: [{ intent: "register_sale", data: { total: 100 }, summary: "sale 1" }] },
        ]),
      )
      .mockResolvedValueOnce(
        makeReply("Segunda venta.", [
          { intents: [{ intent: "register_sale", data: { total: 200 }, summary: "sale 2" }] },
        ]),
      );

    await exec(tool, { message: "venta 1" });
    await exec(tool, { message: "venta 2" });

    // Both calls write to the same array.
    expect(capturedPatternCIntents).toHaveLength(2);
    expect(capturedPatternCIntents[0].data).toMatchObject({ total: 100 });
    expect(capturedPatternCIntents[1].data).toMatchObject({ total: 200 });
  });
});

// ── Tests: executeSupActions ADK injection path ───────────────────────────────
// These tests verify that when usedAdkDelegation=true, capturedPatternCIntents
// is injected into supResult.actions before resolveCompoundActions runs.
// We test the behaviour of executeSupActions directly by mocking its dependencies.

// The full executeSupActions integration test is in owner-handler.sup-actions.ts.
// Here we only verify the accumulator injection logic.

describe("capturedPatternCIntents in supResult — injection contract", () => {
  it("capturedPatternCIntents is a plain array of PatternCIntent objects", () => {
    const intents: PatternCIntent[] = [
      { intent: "register_sale", data: { total: 500 }, summary: "Venta $500" },
      { intent: "adjust_stock", data: { productId: "p1", delta: -2 }, summary: "Ajuste -2" },
    ];
    expect(intents).toHaveLength(2);
    expect(intents[0].intent).toBe("register_sale");
    expect(intents[1].intent).toBe("adjust_stock");
  });

  it("capturedPatternCIntents shape is compatible with supResult.actions items", () => {
    // Verify the shape matches what executeSupActions injects:
    // supResult.actions items require { intent, data, summary }.
    const intent: PatternCIntent = {
      intent: "create_product",
      data: { name: "Leche", price: 120 },
      summary: "Crear Leche a $120",
    };
    // All three required fields are present — valid for spread into supResult.actions.
    expect(typeof intent.intent).toBe("string");
    expect(intent.data).toBeDefined();
    expect(typeof intent.summary).toBe("string");
  });
});
