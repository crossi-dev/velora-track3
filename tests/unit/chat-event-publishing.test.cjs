const assert = require("node:assert/strict");
const test = require("node:test");

// Stub env vars required by src/lib/env.ts before importing modules that
// transitively touch prisma/env. Tests don't actually hit the DB — they only
// exercise pure builder/parser/formatter logic.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-not-for-production";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";

const {
  buildChatMessageEvent,
  buildCompanionResponseEvent,
  buildSupervisorQueryEvent,
} = require("../../src/app/api/_lib/agent-events.ts");

const {
  parseEmployeeEvent,
  formatEventTextSummary,
  EMPLOYEE_EVENT_PROTOCOL,
} = require("../../src/lib/agent-contract.ts");

// ── buildChatMessageEvent ──────────────────────────────────────────────

test("buildChatMessageEvent: shape mínimo válido", () => {
  const ev = buildChatMessageEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    text: "vendí 2 lattes a Juan",
    locale: "es-AR",
    actorRole: "employee",
    clientMessageId: "cm_1",
  });
  assert.equal(ev.type, "CHAT_MESSAGE");
  assert.equal(ev.businessId, "biz_1");
  assert.equal(ev.actorEmployeeId, "emp_1");
  assert.equal(ev.text, "vendí 2 lattes a Juan");
  assert.equal(ev.locale, "es-AR");
  assert.equal(ev.actorRole, "employee");
  assert.equal(ev.clientMessageId, "cm_1");
  assert.equal(ev.protocol, EMPLOYEE_EVENT_PROTOCOL.name);
  assert.equal(ev.protocolVersion, EMPLOYEE_EVENT_PROTOCOL.version);
  assert.equal(typeof ev.eventId, "string");
  assert.equal(typeof ev.emittedAt, "string");
});

test("buildChatMessageEvent: text truncado a 500 chars", () => {
  const longText = "a".repeat(800);
  const ev = buildChatMessageEvent({
    businessId: "biz_1",
    actorEmployeeId: null,
    text: longText,
    locale: null,
    actorRole: "owner",
    clientMessageId: null,
  });
  assert.equal(ev.text.length, 500);
});

test("buildChatMessageEvent: actorRole owner sin employeeId", () => {
  const ev = buildChatMessageEvent({
    businessId: "biz_1",
    actorEmployeeId: null,
    text: "hola",
    locale: null,
    actorRole: "owner",
    clientMessageId: null,
  });
  assert.equal(ev.actorRole, "owner");
  assert.equal(ev.actorEmployeeId, null);
});

// ── buildCompanionResponseEvent ────────────────────────────────────────

test("buildCompanionResponseEvent: shape mínimo válido", () => {
  const ev = buildCompanionResponseEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    inReplyToEventId: "evt_inbound",
    intent: "register_sale",
    safeIntent: "register_sale",
    answer: "Listo, registrada la venta.",
    confidence: 0.95,
    requiresClarification: false,
    actionsEmitted: ["register_sale"],
  });
  assert.equal(ev.type, "COMPANION_RESPONSE");
  assert.equal(ev.inReplyToEventId, "evt_inbound");
  assert.equal(ev.intent, "register_sale");
  assert.equal(ev.safeIntent, "register_sale");
  assert.equal(ev.answer, "Listo, registrada la venta.");
  assert.equal(ev.confidence, 0.95);
  assert.equal(ev.requiresClarification, false);
  assert.deepEqual(ev.actionsEmitted, ["register_sale"]);
});

test("buildCompanionResponseEvent: clarificación requerida", () => {
  const ev = buildCompanionResponseEvent({
    businessId: "biz_1",
    actorEmployeeId: null,
    inReplyToEventId: "evt_inbound",
    intent: "register_sale",
    safeIntent: "register_sale",
    answer: "No tengo stock suficiente.",
    confidence: null,
    requiresClarification: true,
    actionsEmitted: [],
  });
  assert.equal(ev.requiresClarification, true);
  assert.deepEqual(ev.actionsEmitted, []);
  assert.equal(ev.confidence, null);
});

// ── buildSupervisorQueryEvent ──────────────────────────────────────────

test("buildSupervisorQueryEvent: B2 long input", () => {
  const ev = buildSupervisorQueryEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    inReplyToEventId: "evt_inbound",
    escalationKind: "B2_long_input",
    supervisorAnswer: "Esto requiere descomponerse en pasos.",
  });
  assert.equal(ev.type, "SUPERVISOR_QUERY");
  assert.equal(ev.escalationKind, "B2_long_input");
  assert.equal(ev.supervisorAnswer, "Esto requiere descomponerse en pasos.");
});

test("buildSupervisorQueryEvent: B1 clarification loop", () => {
  const ev = buildSupervisorQueryEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    inReplyToEventId: "evt_inbound",
    escalationKind: "B1_clarification_loop",
    supervisorAnswer: "Re-clarificación post-tier 3.",
  });
  assert.equal(ev.escalationKind, "B1_clarification_loop");
});

// ── parseEmployeeEvent: round-trip ─────────────────────────────────────

test("parseEmployeeEvent: round-trip CHAT_MESSAGE", () => {
  const ev = buildChatMessageEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    text: "test",
    locale: null,
    actorRole: "employee",
    clientMessageId: null,
  });
  const round = parseEmployeeEvent(JSON.parse(JSON.stringify(ev)));
  assert.notEqual(round, null);
  assert.equal(round.type, "CHAT_MESSAGE");
  assert.equal(round.text, "test");
});

test("parseEmployeeEvent: round-trip COMPANION_RESPONSE", () => {
  const ev = buildCompanionResponseEvent({
    businessId: "biz_1",
    actorEmployeeId: null,
    inReplyToEventId: "evt_x",
    intent: "answer",
    safeIntent: "answer",
    answer: "ok",
    confidence: 0.8,
    requiresClarification: false,
    actionsEmitted: [],
  });
  const round = parseEmployeeEvent(JSON.parse(JSON.stringify(ev)));
  assert.notEqual(round, null);
  assert.equal(round.type, "COMPANION_RESPONSE");
  assert.equal(round.inReplyToEventId, "evt_x");
});

test("parseEmployeeEvent: round-trip SUPERVISOR_QUERY", () => {
  const ev = buildSupervisorQueryEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    inReplyToEventId: "evt_y",
    escalationKind: "B2_long_input",
    supervisorAnswer: "rta del supervisor",
  });
  const round = parseEmployeeEvent(JSON.parse(JSON.stringify(ev)));
  assert.notEqual(round, null);
  assert.equal(round.type, "SUPERVISOR_QUERY");
  assert.equal(round.escalationKind, "B2_long_input");
});

// ── parseEmployeeEvent: rejects malformed ──────────────────────────────

test("parseEmployeeEvent: rechaza CHAT_MESSAGE sin actorRole", () => {
  const result = parseEmployeeEvent({
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: "evt_1",
    emittedAt: new Date().toISOString(),
    type: "CHAT_MESSAGE",
    businessId: "biz_1",
    actorEmployeeId: null,
    text: "hola",
    // actorRole missing
  });
  assert.equal(result, null);
});

test("parseEmployeeEvent: rechaza SUPERVISOR_QUERY con escalationKind inválido", () => {
  const result = parseEmployeeEvent({
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: "evt_1",
    emittedAt: new Date().toISOString(),
    type: "SUPERVISOR_QUERY",
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    inReplyToEventId: "evt_x",
    escalationKind: "INVALID_KIND",
    supervisorAnswer: "rta",
  });
  assert.equal(result, null);
});

test("parseEmployeeEvent: rechaza COMPANION_RESPONSE con actionsEmitted no-array", () => {
  const result = parseEmployeeEvent({
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: "evt_1",
    emittedAt: new Date().toISOString(),
    type: "COMPANION_RESPONSE",
    businessId: "biz_1",
    actorEmployeeId: null,
    inReplyToEventId: "evt_x",
    intent: "answer",
    safeIntent: "answer",
    answer: "rta",
    confidence: null,
    requiresClarification: false,
    actionsEmitted: "not an array",
  });
  assert.equal(result, null);
});

// ── formatEventTextSummary: 3 new types ────────────────────────────────

test("formatEventTextSummary: CHAT_MESSAGE", () => {
  const ev = buildChatMessageEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    text: "vendí 2 lattes a Juan",
    locale: null,
    actorRole: "employee",
    clientMessageId: null,
  });
  const summary = formatEventTextSummary(ev);
  assert.match(summary, /^CHAT_MESSAGE/);
  assert.ok(summary.includes("employee"));
  assert.ok(summary.includes("vendí 2 lattes"));
});

test("formatEventTextSummary: CHAT_MESSAGE truncado", () => {
  const longText = "x".repeat(200);
  const ev = buildChatMessageEvent({
    businessId: "biz_1",
    actorEmployeeId: null,
    text: longText,
    locale: null,
    actorRole: "owner",
    clientMessageId: null,
  });
  const summary = formatEventTextSummary(ev);
  // El summary trunca a 60 chars con "…"
  assert.ok(summary.includes("…"));
});

test("formatEventTextSummary: COMPANION_RESPONSE", () => {
  const ev = buildCompanionResponseEvent({
    businessId: "biz_1",
    actorEmployeeId: null,
    inReplyToEventId: "evt_x",
    intent: "register_sale",
    safeIntent: "register_sale",
    answer: "Listo",
    confidence: 0.9,
    requiresClarification: false,
    actionsEmitted: ["register_sale", "stock_load"],
  });
  const summary = formatEventTextSummary(ev);
  assert.match(summary, /^COMPANION_RESPONSE/);
  assert.ok(summary.includes("register_sale"));
});

test("formatEventTextSummary: SUPERVISOR_QUERY", () => {
  const ev = buildSupervisorQueryEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    inReplyToEventId: "evt_x",
    escalationKind: "B2_long_input",
    supervisorAnswer: "rta",
  });
  const summary = formatEventTextSummary(ev);
  assert.match(summary, /^SUPERVISOR_QUERY/);
  assert.ok(summary.includes("B2_long_input"));
  assert.ok(summary.includes("evt_x"));
});

// ── Property: chain inReplyToEventId ───────────────────────────────────

test("encadenamiento: COMPANION_RESPONSE.inReplyToEventId apunta al CHAT_MESSAGE.eventId", () => {
  const inbound = buildChatMessageEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    text: "vendí 2 lattes",
    locale: null,
    actorRole: "employee",
    clientMessageId: null,
  });
  const response = buildCompanionResponseEvent({
    businessId: "biz_1",
    actorEmployeeId: "emp_1",
    inReplyToEventId: inbound.eventId,
    intent: "register_sale",
    safeIntent: "register_sale",
    answer: "Listo",
    confidence: 0.95,
    requiresClarification: false,
    actionsEmitted: ["register_sale"],
  });
  assert.equal(response.inReplyToEventId, inbound.eventId);
  assert.notEqual(response.eventId, inbound.eventId, "eventos deben tener eventIds distintos");
});
