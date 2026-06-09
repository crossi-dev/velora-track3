const assert = require("node:assert/strict");
const test = require("node:test");

// Stub fetch antes del require — sendMessage usa fetch global.
globalThis.fetch = globalThis.fetch || (async () => new Response("{}", { status: 200 }));

const {
  TestTransport,
  getActiveTransportKind,
  setTransportForTest,
  getA2ATransport,
} = require("../../src/lib/a2a-transport.ts");

function buildEvent() {
  return {
    protocol: "velora.employee.event",
    protocolVersion: "1.0.0",
    eventId: "test-evt-001",
    emittedAt: "2026-04-28T12:00:00.000Z",
    type: "SHIFT_START",
    businessId: "biz-test",
    actorEmployeeId: "emp-test",
    loginAt: "2026-04-28T12:00:00.000Z",
  };
}

// ── getActiveTransportKind ────────────────────────────────────────────

test("getActiveTransportKind: default loopback when env unset", () => {
  delete process.env.A2A_TRANSPORT;
  assert.equal(getActiveTransportKind(), "loopback");
});

test("getActiveTransportKind: pubsub when env set", () => {
  process.env.A2A_TRANSPORT = "pubsub";
  assert.equal(getActiveTransportKind(), "pubsub");
  delete process.env.A2A_TRANSPORT;
});

test("getActiveTransportKind: case-insensitive", () => {
  process.env.A2A_TRANSPORT = "PUBSUB";
  assert.equal(getActiveTransportKind(), "pubsub");
  delete process.env.A2A_TRANSPORT;
});

test("getActiveTransportKind: unknown value → loopback", () => {
  process.env.A2A_TRANSPORT = "rabbitmq";
  assert.equal(getActiveTransportKind(), "loopback");
  delete process.env.A2A_TRANSPORT;
});

// ── TestTransport ─────────────────────────────────────────────────────

test("TestTransport: captura published events", async () => {
  const t = new TestTransport();
  const event = buildEvent();
  await t.publish(event);
  assert.equal(t.published.length, 1);
  assert.equal(t.published[0].eventId, "test-evt-001");
});

test("TestTransport: messageId default basado en eventId", async () => {
  const t = new TestTransport();
  const result = await t.publish(buildEvent());
  assert.match(result.messageId, /test-/);
});

test("TestTransport: setReply override", async () => {
  const t = new TestTransport();
  t.setReply({
    messageId: "fixed-msg",
    notification: { level: "now", title: "test", body: "body", reason: "r" },
  });
  const result = await t.publish(buildEvent());
  assert.equal(result.messageId, "fixed-msg");
  assert.equal(result.notification.level, "now");
});

test("TestTransport: reset limpia state", async () => {
  const t = new TestTransport();
  await t.publish(buildEvent());
  assert.equal(t.published.length, 1);
  t.reset();
  assert.equal(t.published.length, 0);
});

// ── setTransportForTest / getA2ATransport ─────────────────────────────

test("setTransportForTest: inyecta transport custom", async () => {
  const fake = new TestTransport();
  setTransportForTest(fake);
  const got = getA2ATransport();
  assert.equal(got, fake);
  setTransportForTest(null);
});

test("getA2ATransport: tras reset retorna instancia real", () => {
  setTransportForTest(null);
  delete process.env.A2A_TRANSPORT;
  const t = getA2ATransport();
  assert.ok(t);
  assert.equal(typeof t.publish, "function");
  setTransportForTest(null);
});
