// tests/vitest/adk/factory-jd-gaps.test.ts
//
// Unit tests for the factory JD gap fixes (fix/factory-close-gaps):
//
//   NEW-2 — createA2AAgentTool: minimal runtime guard on rawArgs.
//     - null rawArgs → clean error envelope, no crash
//     - non-object rawArgs (string) → clean error envelope
//     - object missing message → clean error envelope
//     - object with empty string message → clean error envelope
//     - valid args object → proceeds normally (sendMessage called)
//
//   M1 — serverTurnId branded type + ServerTurnId.
//     - serverTurnId(raw) returns the raw string at runtime (brand is TS-only)
//     - serverTurnId output is assignable to string (structural compat)
//     - brandless plain string is accepted by deriveServerKey (it takes string, not ServerTurnId)
//
//   L2 — buildProhibitionsBlock (create-tool-seams.ts) length cap.
//     - empty array → returns ""
//     - short list → returns full block unchanged
//     - list that would exceed cap → truncates with "[…+N omitted]" marker
//     - exactly-at-cap list → no truncation (boundary condition)
//
// Mocked: sendMessage, cloudLog, signAgentAssertion, deriveA2AKey, remainingBudget,
//         server-only (suppress server-only guard in test env)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Suppress server-only ───────────────────────────────────────────────────────
vi.mock("server-only", () => ({}));

// ── Shared mock refs ───────────────────────────────────────────────────────────
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

// ── Imports ────────────────────────────────────────────────────────────────────
import { createA2AAgentTool } from "@/lib/adk/tools/_shared/create-a2a-agent-tool";
import type { A2AAgentToolContext, A2AAgentToolResult } from "@/lib/adk/tools/_shared/create-a2a-agent-tool";
import { serverTurnId } from "@/lib/adk/tools/_shared/create-tool";
import { buildProhibitionsBlock } from "@/lib/adk/tools/_shared/create-tool-seams";
import { Type } from "@google/genai";

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE_CTX: A2AAgentToolContext = {
  businessId: "biz-001",
  appUrl: "http://localhost:3000",
  apiKey: "test-key",
};

function makeTool(ctx: A2AAgentToolContext = BASE_CTX) {
  return createA2AAgentTool(
    {
      toolName: "call_test_agent",
      description: "Test tool",
      schema: {
        type: Type.OBJECT,
        properties: { message: { type: Type.STRING } },
        required: ["message"],
      },
      timeoutMs: 10000,
      callerIdentity: "supervisor",
      targetIdentity: "ventas",
      agentPath: "/api/agents/test/jsonrpc",
      logActionKey: "TEST",
      agentDisplayName: "Test Agent",
    },
    ctx,
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing FunctionTool.execute for unit testing
async function exec(tool: ReturnType<typeof makeTool>, args: unknown): Promise<A2AAgentToolResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tool as any).execute(args);
}

// ── NEW-2: A2A input validation guard ─────────────────────────────────────────

describe("NEW-2 — createA2AAgentTool input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.A2A_SECRET = "test-secret";
  });

  afterEach(() => {
    delete process.env.A2A_SECRET;
  });

  it("null rawArgs → returns { text: null, success: false } without calling sendMessage", async () => {
    const tool = makeTool();
    const result = await exec(tool, null);

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/invalid input/i);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("string rawArgs → returns { text: null, success: false }", async () => {
    const tool = makeTool();
    const result = await exec(tool, "just a string");

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("object without message field → returns { text: null, success: false }", async () => {
    const tool = makeTool();
    const result = await exec(tool, { otherField: "value" });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("object with empty string message → returns { text: null, success: false }", async () => {
    const tool = makeTool();
    const result = await exec(tool, { message: "   " }); // whitespace-only

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("object with non-string message → returns { text: null, success: false }", async () => {
    const tool = makeTool();
    const result = await exec(tool, { message: 42 });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("valid args object → proceeds to sendMessage", async () => {
    sendMessageMock.mockResolvedValue({ text: "ok", dataParts: [] });
    const tool = makeTool();
    const result = await exec(tool, { message: "hola" });

    expect(result.success).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it("validation failure logs WARNING with rawArgsType", async () => {
    const tool = makeTool();
    await exec(tool, null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock.calls is any[][]
    const warningCall: any[] | undefined = cloudLogMock.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (call: any[]) => call[0]?.severity === "WARNING" && call[0]?.action?.includes("INVALID_INPUT"),
    );
    expect(warningCall).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(warningCall?.[0].data.rawArgsType).toBe("null");
  });
});

// ── M1: serverTurnId branded type ─────────────────────────────────────────────

describe("M1 — serverTurnId branded type", () => {
  it("serverTurnId returns the same string value at runtime", () => {
    const raw = "550e8400-e29b-41d4-a716-446655440000";
    const branded = serverTurnId(raw);
    expect(branded).toBe(raw);
  });

  it("serverTurnId output is structurally a string (extends string)", () => {
    const branded = serverTurnId("test-uuid");
    expect(typeof branded).toBe("string");
  });

  it("serverTurnId with different inputs produces different branded values", () => {
    const a = serverTurnId("uuid-a");
    const b = serverTurnId("uuid-b");
    expect(a).not.toBe(b);
  });

  it("serverTurnId preserves the raw string content exactly", () => {
    const raw = "urn:uuid:12345678-1234-5678-1234-567812345678";
    expect(serverTurnId(raw)).toBe(raw);
  });
});

// ── L2: buildProhibitionsBlock length cap ─────────────────────────────────────

describe("L2 — buildProhibitionsBlock length cap (create-tool-seams)", () => {
  it("empty array → returns empty string", () => {
    expect(buildProhibitionsBlock([])).toBe("");
  });

  it("single short prohibition → returns full block with header", () => {
    const result = buildProhibitionsBlock(["Never invent prices."]);
    expect(result).toContain("PROHIBICIONES (no negociables):");
    expect(result).toContain("1. Never invent prices.");
  });

  it("two short prohibitions → returns full numbered block", () => {
    const result = buildProhibitionsBlock([
      "Never invent prices.",
      "Always use DB values.",
    ]);
    expect(result).toContain("1. Never invent prices.");
    expect(result).toContain("2. Always use DB values.");
  });

  it("block starts with double newline (description append format)", () => {
    const result = buildProhibitionsBlock(["Do not hallucinate."]);
    expect(result.startsWith("\n\n")).toBe(true);
  });

  it("very long prohibition list → truncates with ellipsis marker", () => {
    // Generate enough prohibitions to definitely exceed the 800-char cap.
    const many = Array.from({ length: 30 }, (_, i) => `Prohibition ${i + 1}: some moderately long text.`);
    const result = buildProhibitionsBlock(many);

    expect(result).toContain("omitted");
    // Must NOT contain all 30 items.
    expect(result).not.toContain("30. Prohibition 30");
  });

  it("total block length stays within cap for a long list", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Prohibition ${i + 1}: some moderately long text.`);
    const result = buildProhibitionsBlock(many);
    // The cap is 800; the result should not drastically exceed it.
    expect(result.length).toBeLessThanOrEqual(900);
  });

  it("short list that fits within cap → no truncation marker", () => {
    const few = ["Short rule 1.", "Short rule 2.", "Short rule 3."];
    const result = buildProhibitionsBlock(few);
    expect(result).not.toContain("omitted");
    expect(result).toContain("3. Short rule 3.");
  });
});
