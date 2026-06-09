// Integration test: server-side confirmation fast-path bypasses the LLM
// when the user types "sí" / "no" / "cancelar" while a confirmationRequest
// is pending on the most recent assistant turn.
//
// We exercise the owner and employee fast-path stages directly with a
// constructed ctx and a runSupervisor / runBusinessAssistantModel mock that
// would throw if called. If the stage does its job, the mock never fires
// and the response carries clientAction:"execute_pending_confirmation" or
// "cancel_pending_confirmation".

// Phase 4 register sets up ts-node + alias resolver; setting these envs
// here so prisma + auth modules pulled transitively by stage files don't
// blow up validateEnv when they load.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-not-used";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("./module-hooks.cjs");

function makeRespond() {
  const calls = [];
  return {
    calls,
    fn: async (body, status = 200) => {
      calls.push({ body, status });
      return { status, body };
    },
  };
}

function makeTrace() {
  const lines = [];
  return {
    add: (step, detail) => lines.push(`${step}:${detail}`),
    toJSON: () => null,
    lines,
  };
}

function makeLatency() {
  const calls = [];
  return {
    calls,
    start: (label) => calls.push({ kind: "start", label }),
    end: (label) => calls.push({ kind: "end", label }),
    setMeta: (k, v) => calls.push({ kind: "setMeta", k, v }),
    emit: (info) => calls.push({ kind: "emit", info }),
  };
}

function makeAssistantTurn(confirmationRequest) {
  return {
    role: "assistant",
    text: confirmationRequest.message ?? "?",
    confirmationRequest,
  };
}

const UNDO_CARD = {
  id: "card-1",
  severity: "warning",
  title: "Confirmar",
  message: "¿Confirmás deshacer la última venta?",
  confirmLabel: "Confirmar",
  cancelLabel: "Cancelar",
  action: { type: "undo", undoTarget: "sale", undoCount: 1 },
};

// Owner pipeline imports a stack of modules (supervisor, planner, etc).
// We mock the heaviest ones so the require chain terminates quickly. The
// detector + helper + stage themselves don't need them — the test asserts
// the stage short-circuits before they're invoked.

function bootstrapOwner() {
  clearMockModules();
  resetSourceModules();
  // Stub heavy modules pulled in via top-level imports. The fast-path
  // stage itself only touches the detector + helper + respond, but the
  // owner stages module loads supervisor + prisma transitively.
  setMockModule("@/lib/prisma", { prisma: {} });
  setMockModule("@/app/api/supervisor/_lib/load-context", {
    loadSupervisorContext: async () => {
      throw new Error("loadSupervisorContext should not be called when fast-path hits");
    },
  });
  setMockModule("@/app/api/supervisor/_lib/business-setup-actions", {
    executeBusinessSetupActions: async () => {
      throw new Error("executeBusinessSetupActions should not be called");
    },
  });
  const stages = require("../../src/app/api/business-assistant/_lib/owner-handler.stages.ts");
  return stages;
}

test("owner fast-path: typed 'sí' resolves pending undo without LLM", async () => {
  const { ownerConfirmationFastPathStage } = bootstrapOwner();
  const respond = makeRespond();
  const trace = makeTrace();
  const latency = makeLatency();

  const result = await ownerConfirmationFastPathStage.run({
    params: {
      text: "sí",
      lang: "es-AR",
      businessId: "biz-1",
      actorUserId: "user-1",
      inboundEventId: null,
      respond: respond.fn,
      trace,
      latency,
      recentHistory: [
        { role: "user", text: "borrá la última venta" },
        makeAssistantTurn(UNDO_CARD),
      ],
    },
    runSupervisor: async () => {
      throw new Error("runSupervisor should not be called");
    },
  });

  assert.ok(result, "stage should return a response");
  assert.equal(respond.calls.length, 1);
  assert.equal(respond.calls[0].body.clientAction, "execute_pending_confirmation");
  assert.deepEqual(respond.calls[0].body.pendingConfirmation.action, UNDO_CARD.action);
  // No "preModel" latency phase was opened — we never touched the LLM.
  assert.equal(latency.calls.filter((c) => c.kind === "start").length, 0);
});

test("owner fast-path: typed 'no' cancels pending without LLM", async () => {
  const { ownerConfirmationFastPathStage } = bootstrapOwner();
  const respond = makeRespond();
  const trace = makeTrace();
  const latency = makeLatency();

  const result = await ownerConfirmationFastPathStage.run({
    params: {
      text: "no",
      lang: "es-AR",
      businessId: "biz-1",
      actorUserId: "user-1",
      inboundEventId: null,
      respond: respond.fn,
      trace,
      latency,
      recentHistory: [makeAssistantTurn(UNDO_CARD)],
    },
    runSupervisor: async () => {
      throw new Error("runSupervisor should not be called");
    },
  });

  assert.ok(result);
  assert.equal(respond.calls[0].body.clientAction, "cancel_pending_confirmation");
  assert.equal(respond.calls[0].body.pendingConfirmation, undefined);
});

test("owner fast-path: ambiguous answer falls through (returns null)", async () => {
  const { ownerConfirmationFastPathStage } = bootstrapOwner();
  const respond = makeRespond();
  const trace = makeTrace();
  const latency = makeLatency();

  const result = await ownerConfirmationFastPathStage.run({
    params: {
      text: "sí pero cambiá el monto",
      lang: "es-AR",
      businessId: "biz-1",
      actorUserId: "user-1",
      inboundEventId: null,
      respond: respond.fn,
      trace,
      latency,
      recentHistory: [makeAssistantTurn(UNDO_CARD)],
    },
    runSupervisor: async () => {
      throw new Error("runSupervisor should not be called by the fast-path stage itself");
    },
  });

  assert.equal(result, null, "ambiguous input must fall through to the LLM");
  assert.equal(respond.calls.length, 0);
});

test("owner fast-path: no pending card → null (LLM handles it)", async () => {
  const { ownerConfirmationFastPathStage } = bootstrapOwner();
  const respond = makeRespond();
  const result = await ownerConfirmationFastPathStage.run({
    params: {
      text: "sí",
      lang: "es-AR",
      businessId: "biz-1",
      actorUserId: "user-1",
      inboundEventId: null,
      respond: respond.fn,
      trace: makeTrace(),
      latency: makeLatency(),
      recentHistory: [{ role: "user", text: "hola" }, { role: "assistant", text: "¡Hola!" }],
    },
    runSupervisor: async () => null,
  });
  assert.equal(result, null);
  assert.equal(respond.calls.length, 0);
});

// ── Employee fast-path ───────────────────────────────────────────────

function bootstrapEmployee() {
  clearMockModules();
  resetSourceModules();
  // Stub heavy supervisor module imports — the stage doesn't use them but
  // the file's top-level imports load them eagerly via ES interop. Same
  // story for prisma + auth (loaded transitively but the fast-path stage
  // never touches the DB).
  setMockModule("@/lib/prisma", { prisma: {} });
  setMockModule("@/app/api/supervisor/route", {
    runSupervisor: async () => {
      throw new Error("supervisor runSupervisor should not be called");
    },
    shouldBypassToSupervisor: () => false,
    supervisorAnswer: () => "",
  });
  const stages = require("../../src/app/api/business-assistant/_lib/employee-handler.stages-a.ts");
  return stages;
}

test("employee fast-path: typed 'dale' resolves pending without LLM", async () => {
  const { employeeConfirmationFastPathStage } = bootstrapEmployee();
  const respond = makeRespond();

  const result = await employeeConfirmationFastPathStage.run({
    params: {
      text: "dale",
      locale: "es-AR",
      lang: "es-AR",
      businessId: "biz-2",
      actorEmployeeId: "emp-1",
      actorUserId: "user-1",
      role: "employee",
      inboundEventId: null,
      respond: respond.fn,
      cacheAndReturn: async (r) => r,
      trace: makeTrace(),
      latency: makeLatency(),
      recentHistory: [makeAssistantTurn(UNDO_CARD)],
      loadedContext: {},
      activeInvoiceId: undefined,
      latestPurchaseRequestId: undefined,
      latestPurchaseRequestNumber: undefined,
    },
    onboardingPrefix: "",
    modelResult: null,
    parsed: null,
    safeIntent: null,
    answer: null,
  });

  assert.ok(result);
  assert.equal(respond.calls[0].body.clientAction, "execute_pending_confirmation");
  assert.equal(respond.calls[0].body.pendingConfirmation.action.type, "undo");
});

test("employee fast-path: 'cancelá' cancels pending without LLM", async () => {
  const { employeeConfirmationFastPathStage } = bootstrapEmployee();
  const respond = makeRespond();

  const result = await employeeConfirmationFastPathStage.run({
    params: {
      text: "cancelá",
      locale: "es-AR",
      lang: "es-AR",
      businessId: "biz-2",
      actorEmployeeId: "emp-1",
      actorUserId: "user-1",
      role: "employee",
      inboundEventId: null,
      respond: respond.fn,
      cacheAndReturn: async (r) => r,
      trace: makeTrace(),
      latency: makeLatency(),
      recentHistory: [makeAssistantTurn(UNDO_CARD)],
      loadedContext: {},
      activeInvoiceId: undefined,
      latestPurchaseRequestId: undefined,
      latestPurchaseRequestNumber: undefined,
    },
    onboardingPrefix: "",
    modelResult: null,
    parsed: null,
    safeIntent: null,
    answer: null,
  });

  assert.ok(result);
  assert.equal(respond.calls[0].body.clientAction, "cancel_pending_confirmation");
});

test("employee fast-path: ambiguous answer falls through", async () => {
  const { employeeConfirmationFastPathStage } = bootstrapEmployee();
  const respond = makeRespond();
  const result = await employeeConfirmationFastPathStage.run({
    params: {
      text: "ok cargá 3 más",
      locale: "es-AR",
      lang: "es-AR",
      businessId: "biz-2",
      actorEmployeeId: "emp-1",
      actorUserId: "user-1",
      role: "employee",
      inboundEventId: null,
      respond: respond.fn,
      cacheAndReturn: async (r) => r,
      trace: makeTrace(),
      latency: makeLatency(),
      recentHistory: [makeAssistantTurn(UNDO_CARD)],
      loadedContext: {},
      activeInvoiceId: undefined,
      latestPurchaseRequestId: undefined,
      latestPurchaseRequestNumber: undefined,
    },
    onboardingPrefix: "",
    modelResult: null,
    parsed: null,
    safeIntent: null,
    answer: null,
  });
  assert.equal(result, null);
  assert.equal(respond.calls.length, 0);
});
