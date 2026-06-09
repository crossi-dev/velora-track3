// G5-2 — Phase 2-7 audit: payload de CriticalWriteEvent guardaba PII en claro.
// Verifica que recordCriticalWriteEvent enmascara phone/email/PIN/etc antes
// de persistir el payloadJson en DB.

const assert = require("node:assert/strict");
const test = require("node:test");

const { recordCriticalWriteEvent } = require("../../src/infrastructure/shared/critical-write-audit.ts");

function mockClient() {
  const writes = [];
  const client = {
    criticalWriteEvent: {
      async create({ data }) {
        writes.push(data);
      },
      async deleteMany() {},
    },
  };
  return { client, writes };
}

async function record(client, payload) {
  return recordCriticalWriteEvent({
    client,
    businessId: "biz_1",
    actorUserId: "user_1",
    routeScope: "test",
    actionType: "TEST",
    resourceType: "test",
    resourceId: null,
    summary: "test",
    payload,
  });
}

test("redacta phone en top level", async () => {
  const { client, writes } = mockClient();
  await record(client, { phone: "+5491155667788", name: "Juan" });
  const persisted = JSON.parse(writes[0].payloadJson);
  assert.notEqual(persisted.phone, "+5491155667788");
  assert.match(persisted.phone, /\*\*\*/);
  assert.equal(persisted.name, "Juan"); // no PII => intacto
});

test("redacta email", async () => {
  const { client, writes } = mockClient();
  await record(client, { email: "carlos@example.com" });
  const persisted = JSON.parse(writes[0].payloadJson);
  assert.match(persisted.email, /\*\*\*/);
  assert.notEqual(persisted.email, "carlos@example.com");
});

test("redacta pin / password / token / apiKey", async () => {
  const { client, writes } = mockClient();
  await record(client, {
    pin: "1234",
    password: "supersecret123",
    token: "tk_abc123def456",
    apiKey: "sk-abcdef",
  });
  const persisted = JSON.parse(writes[0].payloadJson);
  assert.equal(persisted.pin, "***"); // <= 4 chars => fully masked
  assert.match(persisted.password, /\*\*\*/);
  assert.match(persisted.token, /\*\*\*/);
  assert.match(persisted.apiKey, /\*\*\*/);
});

test("redacta dni / cuit / direccion", async () => {
  const { client, writes } = mockClient();
  await record(client, {
    dni: "30123456",
    cuit: "20-30123456-7",
    direccion: "Av Corrientes 1234",
  });
  const persisted = JSON.parse(writes[0].payloadJson);
  assert.match(persisted.dni, /\*\*\*/);
  assert.match(persisted.cuit, /\*\*\*/);
  assert.match(persisted.direccion, /\*\*\*/);
});

test("redacta nested customer.phone", async () => {
  const { client, writes } = mockClient();
  await record(client, {
    saleId: "s_123",
    customer: { id: "c_1", name: "Juan", phone: "+5491111111111" },
  });
  const persisted = JSON.parse(writes[0].payloadJson);
  assert.equal(persisted.saleId, "s_123");
  assert.equal(persisted.customer.id, "c_1");
  assert.equal(persisted.customer.name, "Juan");
  assert.match(persisted.customer.phone, /\*\*\*/);
});

test("redacta dentro de arrays", async () => {
  const { client, writes } = mockClient();
  await record(client, {
    customers: [
      { name: "A", phone: "+5491111111111" },
      { name: "B", phone: "+5492222222222" },
    ],
  });
  const persisted = JSON.parse(writes[0].payloadJson);
  assert.equal(persisted.customers[0].name, "A");
  assert.match(persisted.customers[0].phone, /\*\*\*/);
  assert.match(persisted.customers[1].phone, /\*\*\*/);
});

test("preserva fields no-PII intactos", async () => {
  const { client, writes } = mockClient();
  const payload = {
    saleId: "s_123",
    totalAmount: 1500,
    items: [{ productId: "p_1", quantity: 2 }],
    paymentMethod: "cash",
  };
  await record(client, payload);
  const persisted = JSON.parse(writes[0].payloadJson);
  assert.deepEqual(persisted, payload);
});

test("primitivos no fallan", async () => {
  const { client, writes } = mockClient();
  await record(client, "just a string");
  assert.equal(writes[0].payloadJson, '"just a string"');
});

test("null payload no rompe", async () => {
  const { client, writes } = mockClient();
  await record(client, null);
  assert.equal(writes[0].payloadJson, "null");
});

test("redacta whatsapp / whatsappNumber", async () => {
  const { client, writes } = mockClient();
  await record(client, { whatsapp: "+5491111111111", whatsappNumber: "+5492222222222" });
  const persisted = JSON.parse(writes[0].payloadJson);
  assert.match(persisted.whatsapp, /\*\*\*/);
  assert.match(persisted.whatsappNumber, /\*\*\*/);
});

test("string corto (<=4) totalmente enmascarado", async () => {
  const { client, writes } = mockClient();
  await record(client, { pin: "ab" });
  const persisted = JSON.parse(writes[0].payloadJson);
  assert.equal(persisted.pin, "***");
});

test("nested deeply (depth>6) cuts off — no infinite loop", async () => {
  const { client, writes } = mockClient();
  // build deeply nested object
  let deep = { phone: "+5491111111111" };
  for (let i = 0; i < 10; i++) deep = { nested: deep };
  await record(client, deep);
  // should not throw — payloadJson exists
  assert.ok(writes[0].payloadJson.length > 0);
});
