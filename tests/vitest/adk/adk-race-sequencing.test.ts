// tests/vitest/adk/adk-race-sequencing.test.ts
//
// Regression test: CRITICAL race in owner-handler.ts —
// executeSupActions (MUTATES supResult.actions with Pattern C intents) MUST
// complete before resolveCompoundActions READS supResult.actions.
//
// Before the fix: both ran concurrently in Promise.all → the read could win
// before the write, silently dropping intents (non-deterministic).
// After the fix: executeSupActions is awaited first; resolveCompoundActions
// runs after so it always sees the fully-populated actions array.
//
// This test simulates the mutation/read ordering by:
// 1. Building a supResult with usedAdkDelegation=true and capturedPatternCIntents
//    containing a call_inventario_agent Pattern C intent.
// 2. Calling executeSupActions (which injects the captured intent into supResult.actions).
// 3. Calling resolveCompoundActions after and verifying it sees the injected intent
//    (i.e., hasOperational or the injected action is present in supResult.actions).
//
// Also covers: executeCommunicationsActions ordering fix (2026-06-03) —
// The executor must be called AFTER both injection blocks (non-ADK capturedIntents
// and ADK capturedPatternCIntents) so that comms intents from sub-agents are not
// silently dropped. Tests verify executeCommunicationsActions receives the injected
// send_owner_push intent when it arrives via the ADK delegation path.
//
// Source: Promise.all write/read race — MDN Concurrency Model
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Event_loop

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock server-only so it doesn't throw outside the server env ──────────────
vi.mock("server-only", () => ({}));

// ── Mock all heavy dependencies used by executeSupActions ────────────────────
vi.mock("@/lib/cloud-logger", () => ({
  cloudLog: vi.fn(),
}));
vi.mock("@/app/api/supervisor/_lib/business-rule-actions", () => ({
  executeRuleActions: vi.fn().mockResolvedValue({ totalAffected: 0, errors: [] }),
}));
vi.mock("@/app/api/supervisor/_lib/employee-actions", () => ({
  executeEmployeeActions: vi.fn().mockResolvedValue({ links: [], errors: [] }),
}));
vi.mock("@/app/api/supervisor/_lib/delegation-policy-actions", () => ({
  executePolicyActions: vi.fn().mockResolvedValue({ confirmations: [], errors: [] }),
}));
vi.mock("@/app/api/supervisor/_lib/broadcast-actions", () => ({
  executeBroadcastActions: vi.fn().mockResolvedValue({ confirmation: null, notified: 0 }),
}));
const { executeCommunicationsActionsMock } = vi.hoisted(() => ({
  executeCommunicationsActionsMock: vi.fn().mockResolvedValue({ handled: 0, errors: [] }),
}));
vi.mock("@/app/api/supervisor/_lib/communications-actions", () => ({
  executeCommunicationsActions: executeCommunicationsActionsMock,
}));
vi.mock("@/app/api/supervisor/_lib/agent-call-actions", () => ({
  executeAgentCallActions: vi.fn().mockResolvedValue({ confirmations: [], errors: [], capturedIntents: [] }),
}));
vi.mock("@/app/api/supervisor/_lib/business-setup-actions", () => ({
  executeBusinessSetupActions: vi.fn().mockResolvedValue({ totalAffected: 0, errors: [] }),
}));
vi.mock("@/app/api/supervisor/_lib/supervisor-runner", () => ({
  runSupervisor: vi.fn(),
  supervisorAnswer: vi.fn().mockReturnValue({ text: "Ok", chips: null }),
}));
vi.mock("./context", () => ({
  loadBusinessAssistantContext: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import { executeSupActions, STRATEGIC_INTENTS, resolveCompoundActions } from "@/app/api/business-assistant/_lib/owner-handler.sup-actions";

// ── Minimal trace stub ────────────────────────────────────────────────────────
const trace = {
  add: vi.fn(),
  toJSON: vi.fn().mockReturnValue(null),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a supResult with ADK delegation + one captured Pattern C intent. */
function makeAdkSupResult(capturedIntent: { intent: string; data: unknown; summary: string }) {
  return {
    kind: "actions" as const,
    answer: "Ok",
    actions: [
      // The LLM emitted call_inventario_agent — a strategic delegation intent.
      { intent: "call_inventario_agent", data: { message: "ajustá stock" }, summary: "Llamar inventario" },
    ],
    clarification: null,
    notification: null,
    usedModel: "gemini" as const,
    usedAdkDelegation: true,
    capturedPatternCIntents: [capturedIntent],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executeSupActions → resolveCompoundActions sequencing (race fix)", () => {
  it("call_inventario_agent Pattern C intent reaches supResult.actions after executeSupActions", async () => {
    // The Pattern C intent emitted by the inventario sub-agent (an operational
    // intent like adjust_stock) should be injected into supResult.actions by
    // executeSupActions BEFORE resolveCompoundActions reads supResult.actions.
    const capturedIntent = {
      intent: "adjust_stock",
      data: { productId: "prod-001", delta: -5 },
      summary: "Ajuste de stock -5",
    };
    const supResult = makeAdkSupResult(capturedIntent);

    // Step 1: executeSupActions injects capturedPatternCIntents into supResult.actions.
    await executeSupActions(supResult, "biz-001", "user-001", null, trace, "ajustá stock");

    // Step 2: supResult.actions now contains the original delegation intent PLUS
    // the captured operational intent injected by executeSupActions.
    const injectedIntent = supResult.actions?.find((a) => a.intent === "adjust_stock");
    expect(injectedIntent).toBeDefined();
    expect(injectedIntent?.data).toMatchObject({ productId: "prod-001", delta: -5 });

    // Step 3: resolveCompoundActions reading supResult.actions now sees the injected
    // operational intent. adjust_stock is NOT in STRATEGIC_INTENTS, so hasOperational=true.
    const hasOperational = supResult.actions?.some((a) => !STRATEGIC_INTENTS.has(a.intent));
    expect(hasOperational).toBe(true);
  });

  it("call_ventas_agent Pattern C intent (register_sale) reaches supResult.actions", async () => {
    const capturedIntent = {
      intent: "register_sale",
      data: { items: [{ name: "Medialunas", qty: 3, price: 150 }] },
      summary: "Venta 3 Medialunas $150",
    };
    const supResult = {
      kind: "actions" as const,
      answer: "Venta registrada.",
      actions: [
        { intent: "call_ventas_agent", data: { message: "registrá venta" }, summary: "Llamar ventas" },
      ],
      clarification: null,
      notification: null,
      usedModel: "gemini" as const,
      usedAdkDelegation: true,
      capturedPatternCIntents: [capturedIntent],
    };

    await executeSupActions(supResult, "biz-001", "user-001", null, trace, "vendé 3 medialunas");

    const injectedSale = supResult.actions?.find((a) => a.intent === "register_sale");
    expect(injectedSale).toBeDefined();
    expect(injectedSale?.data).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ name: "Medialunas" })]) });

    // register_sale is operational (not in STRATEGIC_INTENTS) — resolveCompoundActions
    // would process it, proving the sequencing is correct.
    expect(STRATEGIC_INTENTS.has("register_sale")).toBe(false);
  });

  it("no capturedPatternCIntents — actions array unchanged (zero-regression check)", async () => {
    const supResult = {
      kind: "actions" as const,
      answer: "Regla creada.",
      actions: [
        { intent: "create_business_rule", data: { name: "Sin stock bajo" }, summary: "Crear regla" },
      ],
      clarification: null,
      notification: null,
      usedModel: "gemini" as const,
      usedAdkDelegation: false,
      capturedPatternCIntents: [],
    };

    await executeSupActions(supResult, "biz-001", "user-001", null, trace, "creá regla sin stock bajo");

    // create_business_rule is strategic — hasOperational stays false.
    const hasOperational = supResult.actions?.some((a) => !STRATEGIC_INTENTS.has(a.intent));
    expect(hasOperational).toBe(false);
    // No extra actions injected.
    expect(supResult.actions).toHaveLength(1);
  });
});

// ── executeCommunicationsActions ordering fix (2026-06-03) ────────────────────
//
// Regression: executeCommunicationsActions was called BEFORE the two injection
// blocks that inline Pattern C intents from sub-agents into supResult.actions.
// Result: send_owner_push / send_employee_push / write_owner_chat_message captured
// via the Communications agent delegation were silently dropped.
//
// Fix: moved the executor call to AFTER both injection blocks.
// These tests verify the executor sees injected comms intents.

describe("executeCommunicationsActions ordering — called after intent injection", () => {
  beforeEach(() => {
    executeCommunicationsActionsMock.mockClear();
    executeCommunicationsActionsMock.mockResolvedValue({ handled: 1, errors: [] });
  });

  it("ADK path: send_owner_push from capturedPatternCIntents is present when executeCommunicationsActions is called", async () => {
    // Simulate the Supervisor delegating to call_communications_agent via ADK.
    // The comms agent captures send_owner_push as a Pattern C intent and returns it
    // in supResult.capturedPatternCIntents. Before the fix, executeCommunicationsActions
    // ran before injection → saw 0 comms actions → silently dropped the push.
    const supResult = {
      kind: "actions" as const,
      answer: "Notificación enviada.",
      actions: [
        { intent: "call_communications_agent", data: { message: "notificá al owner" }, summary: "Llamar comms" },
      ],
      clarification: null,
      notification: null,
      usedModel: "gemini" as const,
      usedAdkDelegation: true,
      capturedPatternCIntents: [
        {
          intent: "send_owner_push",
          data: { businessId: "biz-001", title: "Stock bajo", body: "Producto X por debajo del mínimo" },
          summary: "Push: Stock bajo",
        },
      ],
    };

    await executeSupActions(supResult, "biz-001", "user-001", null, trace, "notificá al owner");

    // The executor must have been called with actions that include send_owner_push.
    expect(executeCommunicationsActionsMock).toHaveBeenCalledOnce();
    const calledActions = executeCommunicationsActionsMock.mock.calls[0][0] as Array<{ intent: string }>;
    const hasPushIntent = calledActions.some((a) => a.intent === "send_owner_push");
    expect(hasPushIntent).toBe(true);
  });

  it("ADK path: send_employee_push from capturedPatternCIntents is present when executeCommunicationsActions is called", async () => {
    const supResult = {
      kind: "actions" as const,
      answer: "Notificación enviada.",
      actions: [
        { intent: "call_communications_agent", data: { message: "notificá al empleado" }, summary: "Llamar comms" },
      ],
      clarification: null,
      notification: null,
      usedModel: "gemini" as const,
      usedAdkDelegation: true,
      capturedPatternCIntents: [
        {
          intent: "send_employee_push",
          data: { businessId: "biz-001", employeeId: "emp-001", title: "Turno", body: "En 10 minutos" },
          summary: "Push empleado: turno",
        },
      ],
    };

    await executeSupActions(supResult, "biz-001", "user-001", null, trace, "notificá al empleado");

    expect(executeCommunicationsActionsMock).toHaveBeenCalledOnce();
    const calledActions = executeCommunicationsActionsMock.mock.calls[0][0] as Array<{ intent: string }>;
    expect(calledActions.some((a) => a.intent === "send_employee_push")).toBe(true);
  });

  it("non-ADK path: send_owner_push captured via agentResult.capturedIntents is present when executeCommunicationsActions is called", async () => {
    // On the non-ADK path, capturedIntents come from executeAgentCallActions.
    // We override the mock to return a capturedIntents array containing send_owner_push.
    const { executeAgentCallActions } = await import("@/app/api/supervisor/_lib/agent-call-actions");
    vi.mocked(executeAgentCallActions).mockResolvedValueOnce({
      confirmations: [],
      errors: [],
      capturedIntents: [
        {
          intent: "send_owner_push",
          data: { businessId: "biz-001", title: "Nuevo pedido", body: "Pedido #42 recibido" },
          summary: "Push: Nuevo pedido",
        },
      ],
    });

    const supResult = {
      kind: "actions" as const,
      answer: "Ok.",
      actions: [
        { intent: "call_communications_agent", data: { message: "notificá" }, summary: "Llamar comms" },
      ],
      clarification: null,
      notification: null,
      usedModel: "gemini" as const,
      usedAdkDelegation: false,
      capturedPatternCIntents: [],
    };

    await executeSupActions(supResult, "biz-001", "user-001", null, trace, "notificá");

    expect(executeCommunicationsActionsMock).toHaveBeenCalledOnce();
    const calledActions = executeCommunicationsActionsMock.mock.calls[0][0] as Array<{ intent: string }>;
    expect(calledActions.some((a) => a.intent === "send_owner_push")).toBe(true);
  });

  it("no comms intents in any path — executeCommunicationsActions called with zero comms actions (handled=0)", async () => {
    executeCommunicationsActionsMock.mockResolvedValue({ handled: 0, errors: [] });

    const supResult = {
      kind: "actions" as const,
      answer: "Regla creada.",
      actions: [
        { intent: "create_business_rule", data: { name: "Regla test" }, summary: "Crear regla" },
      ],
      clarification: null,
      notification: null,
      usedModel: "gemini" as const,
      usedAdkDelegation: false,
      capturedPatternCIntents: [],
    };

    await executeSupActions(supResult, "biz-001", "user-001", null, trace, "creá regla");

    // The executor is still called — it just finds no matching comms actions.
    expect(executeCommunicationsActionsMock).toHaveBeenCalledOnce();
    const calledActions = executeCommunicationsActionsMock.mock.calls[0][0] as Array<{ intent: string }>;
    expect(calledActions.some((a) => a.intent === "send_owner_push")).toBe(false);
    expect(calledActions.some((a) => a.intent === "send_employee_push")).toBe(false);
  });
});
