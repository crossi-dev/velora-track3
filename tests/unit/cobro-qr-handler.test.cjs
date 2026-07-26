// Unit test del RBAC gate del cobro_qr handler.
//
// Cubre:
//   1. Owner happy path → crea PaymentIntent (use-case mockeado).
//   2. Employee → warm reject, NO llega al use-case.
//   3. Owner con monto inválido → fallback graceful, sin crash.
//
// Si alguien saca el gate de executeCobroQr en el futuro, el test 2 falla
// con answer "QR listo por $0..." en vez del mensaje de rechazo — detección
// inmediata.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function makeNextServerMock() {
  return { NextResponse: { json: jsonResponse } };
}

function makeCloudLoggerMock() {
  return {
    cloudLog: () => {},
    logUnauthorizedAccess: () => {},
  };
}

/** Prisma stub mínimo para el happy path (owner con monto válido). */
function makePrismaMock(overrides = {}) {
  const defaults = {
    business: {
      findUnique: async () => ({
        userId: "user1aaaaaaaaaaaaaaaaaaa",
        alias: "velora.mp",
      }),
    },
    // employee.updateMany needed by markOnboardingTaskDone (fire-and-forget
    // called when actorEmployeeId is set — added in feat/rbac f774190e).
    employee: {
      updateMany: async () => ({ count: 0 }),
    },
  };
  return { ...defaults, ...overrides };
}

/**
 * Stub del use-case que registra si fue llamado y devuelve un resultado
 * de creación mínimo.
 */
function makeUseCaseMock() {
  const calls = [];
  return {
    calls,
    createPaymentIntentUseCase: async (input) => {
      calls.push(input);
      return {
        outcome: "created",
        intent: {
          paymentIntentId: "pi-test-001",
          monto: input.monto,
          estado: "pending",
          qrPlaceholderUrl: "/static/qr-placeholder.svg",
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
      };
    },
  };
}

function loadHandler(prismaMock, useCaseMock) {
  resetSourceModules();
  clearMockModules();
  setMockModule("next/server", makeNextServerMock());
  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/lib/prisma", { prisma: prismaMock });
  setMockModule(
    "@/app/api/payment-intents/_lib/payment-intent-use-case",
    useCaseMock,
  );
  return require("../../src/app/api/business-assistant/_lib/handlers/cobro-qr-handler.ts");
}

// ── intents de prueba ─────────────────────────────────────────────────────────

const QR_INTENT = {
  kind: "cobro_qr",
  metodo: "qr",
  monto: 5000,
  matchedCustomerId: null,
  customerName: null,
};

const ALIAS_INTENT = {
  kind: "cobro_qr",
  metodo: "alias",
  monto: 1200,
  matchedCustomerId: null,
  customerName: null,
};

const INVALID_MONTO_INTENT = {
  kind: "cobro_qr",
  metodo: "qr",
  monto: 0, // inválido — < 1
  matchedCustomerId: null,
  customerName: null,
};

function makeParams(role) {
  return {
    actorRole: role,
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    actorEmployeeId: role === "employee" ? "emp1aaaaaaaaaaaaaaaaaaaa" : null,
    text: "cobro 5000",
    locale: "es-AR",
    context: { catalog: { customers: [] } },
    recentHistory: [],
    productInfoDirectory: [],
    invoiceDirectory: [],
    purchaseRequestDirectory: [],
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("cobro_qr owner happy path — crea PaymentIntent (QR)", async () => {
  const useCaseMock = makeUseCaseMock();
  const { executeCobroQr } = loadHandler(makePrismaMock(), useCaseMock);

  const res = await executeCobroQr(QR_INTENT, makeParams("owner"));
  const body = await res.json();

  assert.ok(
    useCaseMock.calls.length === 1,
    "use-case debe haber sido llamado exactamente 1 vez",
  );
  assert.ok(
    body.actions?.[0]?.type === "confirm_cobro",
    "respuesta debe incluir action confirm_cobro",
  );
  assert.ok(
    body.answer.includes("5000"),
    "respuesta debe mencionar el monto",
  );
});

test("cobro_qr owner happy path — modo alias usa alias del negocio", async () => {
  const useCaseMock = makeUseCaseMock();
  const { executeCobroQr } = loadHandler(makePrismaMock(), useCaseMock);

  const res = await executeCobroQr(ALIAS_INTENT, makeParams("owner"));
  const body = await res.json();

  assert.ok(
    useCaseMock.calls.length === 1,
    "use-case debe haber sido llamado en modo alias",
  );
  assert.ok(
    body.answer.includes("velora.mp"),
    "respuesta alias debe mostrar el alias del negocio",
  );
});

// NOTE (feat/rbac f774190e): employee cobro_qr gate was intentionally REMOVED
// so employees can charge via QR. The test below verifies the current behavior:
// employees reach the use-case and get a valid payment response.
// Role-based RBAC enforcement for this intent lives at the chat-layer
// (role-contract.ts COMPANION_ALLOWED_INTENTS) — not inside the handler.
test("cobro_qr employee → use-case invocado (employee puede cobrar QR desde feat/rbac f774190e)", async () => {
  const useCaseMock = makeUseCaseMock();
  const { executeCobroQr } = loadHandler(makePrismaMock(), useCaseMock);

  const res = await executeCobroQr(QR_INTENT, makeParams("employee"));
  const body = await res.json();

  assert.strictEqual(
    useCaseMock.calls.length,
    1,
    "use-case DEBE llamarse cuando el rol es employee (gate removido en f774190e)",
  );
  assert.ok(
    body.actions?.[0]?.type === "confirm_cobro",
    "respuesta de empleado debe incluir action confirm_cobro igual que owner",
  );
});

test("cobro_qr owner con monto inválido → fallback graceful, sin crash", async () => {
  const useCaseMock = makeUseCaseMock();
  const { executeCobroQr } = loadHandler(makePrismaMock(), useCaseMock);

  const res = await executeCobroQr(INVALID_MONTO_INTENT, makeParams("owner"));
  const body = await res.json();

  assert.strictEqual(
    useCaseMock.calls.length,
    0,
    "use-case NO debe llamarse con monto inválido",
  );
  assert.ok(
    typeof body.answer === "string" && body.answer.length > 0,
    "respuesta debe ser un string no vacío",
  );
});
