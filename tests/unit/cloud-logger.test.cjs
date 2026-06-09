const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cloudLog,
  logA2ATransfer,
  logUnauthorizedAccess,
} = require("../../src/lib/cloud-logger.ts");

// ── Capture stdout/stderr to inspect emitted JSON ──────────────────────

function captureConsole(fn) {
  const captured = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (s) => captured.push({ stream: "log", line: s });
  console.warn = (s) => captured.push({ stream: "warn", line: s });
  console.error = (s) => captured.push({ stream: "error", line: s });
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return captured;
}

function parseLast(captured) {
  assert.equal(captured.length, 1, "expected one log line");
  return JSON.parse(captured[0].line);
}

// ── cloudLog ──────────────────────────────────────────────────────────

test("cloudLog: emite JSON válido en una línea", () => {
  const caps = captureConsole(() => {
    cloudLog({
      severity: "INFO",
      message: "test",
      component: "System",
      action: "TEST_ACTION",
      a2a_transfer: false,
    });
  });
  const entry = parseLast(caps);
  assert.equal(entry.severity, "INFO");
  assert.equal(entry.message, "test");
  assert.equal(entry.component, "System");
  assert.equal(entry.action, "TEST_ACTION");
  assert.equal(entry.a2a_transfer, false);
  assert.ok(entry.time, "timestamp se rellena automáticamente");
});

test("cloudLog: WARNING va a stderr (console.warn)", () => {
  const caps = captureConsole(() => {
    cloudLog({
      severity: "WARNING",
      message: "warn",
      component: "RBAC",
      action: "X",
      a2a_transfer: false,
    });
  });
  assert.equal(caps[0].stream, "warn");
});

test("cloudLog: ERROR va a stderr (console.error)", () => {
  const caps = captureConsole(() => {
    cloudLog({
      severity: "ERROR",
      message: "err",
      component: "System",
      action: "X",
      a2a_transfer: false,
    });
  });
  assert.equal(caps[0].stream, "error");
});

test("cloudLog: respeta timestamp explícito", () => {
  const caps = captureConsole(() => {
    cloudLog({
      severity: "INFO",
      message: "x",
      component: "System",
      action: "X",
      a2a_transfer: false,
      timestamp: "2026-04-28T12:00:00.000Z",
    });
  });
  const entry = parseLast(caps);
  assert.equal(entry.timestamp, "2026-04-28T12:00:00.000Z");
});

// ── logA2ATransfer ────────────────────────────────────────────────────

test("logA2ATransfer: severity INFO + a2a_transfer: true + flecha en message", () => {
  const caps = captureConsole(() => {
    logA2ATransfer({
      source: "Employee",
      destination: "Supervisor",
      action: "SALE_REPORT",
      message: "Empleado registró venta",
      data: { saleId: "abc", qty: 2 },
      businessId: "biz-1",
      eventId: "evt-1",
    });
  });
  const entry = parseLast(caps);
  assert.equal(entry.severity, "INFO");
  assert.equal(entry.a2a_transfer, true);
  assert.equal(entry.component, "Employee");
  assert.equal(entry.action, "SALE_REPORT");
  assert.match(entry.message, /→ Supervisor/);
  assert.equal(entry.data.source, "Employee");
  assert.equal(entry.data.destination, "Supervisor");
  assert.equal(entry.data.saleId, "abc");
  assert.equal(entry.businessId, "biz-1");
  assert.equal(entry.eventId, "evt-1");
});

test("logA2ATransfer: Supervisor → Owner también funciona (notificación push)", () => {
  const caps = captureConsole(() => {
    logA2ATransfer({
      source: "Supervisor",
      destination: "Owner",
      action: "PUSH_NOTIFICATION",
      message: "Supervisor decide notificar al dueño",
      data: { level: "now", title: "Stock crítico" },
      businessId: "biz-1",
    });
  });
  const entry = parseLast(caps);
  assert.equal(entry.component, "Supervisor");
  assert.equal(entry.data.destination, "Owner");
  assert.equal(entry.data.level, "now");
});

// ── logUnauthorizedAccess ─────────────────────────────────────────────

test("logUnauthorizedAccess: WARNING + UNAUTHORIZED_ACCESS + RBAC component", () => {
  const caps = captureConsole(() => {
    logUnauthorizedAccess({
      attemptedAction: "edit_product",
      actorRole: "cashier",
      endpoint: "/api/products [PATCH]",
      businessId: "biz-1",
      actorEmployeeId: "emp-1",
    });
  });
  const entry = parseLast(caps);
  assert.equal(entry.severity, "WARNING");
  assert.equal(entry.action, "UNAUTHORIZED_ACCESS");
  assert.equal(entry.component, "RBAC");
  assert.equal(entry.a2a_transfer, false);
  assert.match(entry.message, /cashier/);
  assert.match(entry.message, /edit_product/);
  assert.equal(entry.data.attemptedAction, "edit_product");
  assert.equal(entry.data.actorRole, "cashier");
  assert.equal(entry.businessId, "biz-1");
  assert.equal(entry.actorEmployeeId, "emp-1");
  // Confirma que llegó a stderr (warn stream)
  assert.equal(caps[0].stream, "warn");
});

test("logUnauthorizedAccess: sin endpoint opcional", () => {
  const caps = captureConsole(() => {
    logUnauthorizedAccess({
      attemptedAction: "stock_load",
      actorRole: "cashier",
    });
  });
  const entry = parseLast(caps);
  assert.equal(entry.severity, "WARNING");
  assert.equal(entry.data.endpoint, undefined);
});
