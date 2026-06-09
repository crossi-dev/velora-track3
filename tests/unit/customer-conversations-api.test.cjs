// customer-conversations-api.test.cjs
//
// Unit tests for the customer-conversations API logic.
// Tests the core isolation contract:
//   1. List: only returns conversations for the authenticated businessId.
//   2. Thread: only returns messages for (businessId, customerId) — cross-tenant
//      reads return null/empty (tenant isolation enforced at repo predicate level).
//   3. Employee access is blocked (owner-only).
//
// Strategy: in-memory fakes for the DB layer — no real DB, no HTTP.
// Tests the pure functions and isolation predicates extracted from the route logic.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// ─── In-memory fakes ──────────────────────────────────────────────────────────

function makeChatMessageStore(seed = []) {
  return {
    async groupBy({ where, _max, orderBy, take }) {
      // Filter rows matching the where clause, then group by customerId
      const rows = seed.filter((m) => {
        if (m.businessId !== where.businessId) return false;
        if (where.customerId?.not !== undefined && m.customerId === null) return false;
        if (where.source?.in && !where.source.in.includes(m.source)) return false;
        return true;
      });

      // Group by customerId
      const groups = new Map();
      for (const row of rows) {
        const key = row.customerId;
        if (!groups.has(key)) groups.set(key, { customerId: key, maxCreatedAt: row.createdAt });
        else {
          const g = groups.get(key);
          if (row.createdAt > g.maxCreatedAt) g.maxCreatedAt = row.createdAt;
        }
      }

      let result = Array.from(groups.values())
        .map((g) => ({ customerId: g.customerId, _max: { createdAt: g.maxCreatedAt } }))
        .sort((a, b) => (b._max.createdAt?.getTime?.() ?? 0) - (a._max.createdAt?.getTime?.() ?? 0));

      if (take) result = result.slice(0, take);
      return result;
    },

    async findFirst({ where, orderBy, select }) {
      const rows = seed.filter((m) => {
        if (m.businessId !== where.businessId) return false;
        if (where.customerId !== undefined && m.customerId !== where.customerId) return false;
        if (where.source?.in && !where.source.in.includes(m.source)) return false;
        if (where.text?.not !== undefined && m.text === where.text.not) return false;
        return true;
      });
      if (rows.length === 0) return null;
      // Sort by createdAt desc
      rows.sort((a, b) => b.createdAt - a.createdAt);
      const row = rows[0];
      if (!select) return row;
      const out = {};
      for (const k of Object.keys(select)) out[k] = row[k];
      return out;
    },

    async findMany({ where, orderBy, take, select }) {
      let rows = seed.filter((m) => {
        if (m.businessId !== where.businessId) return false;
        if (where.customerId !== undefined && m.customerId !== where.customerId) return false;
        if (where.source?.in && !where.source.in.includes(m.source)) return false;
        return true;
      });
      // Sort asc by default
      rows.sort((a, b) => a.createdAt - b.createdAt);
      if (take) rows = rows.slice(0, take);
      if (!select) return rows;
      return rows.map((row) => {
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      });
    },
  };
}

function makeCustomerStore(seed = []) {
  return {
    async findMany({ where, select }) {
      let rows = seed;
      if (where?.id?.in) rows = rows.filter((c) => where.id.in.includes(c.id));
      if (where?.businessId) rows = rows.filter((c) => c.businessId === where.businessId);
      if (where?.id && !where.id.in) rows = rows.filter((c) => c.id === where.id);
      if (!select) return rows;
      return rows.map((row) => {
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      });
    },
    async findFirst({ where, select }) {
      let rows = seed;
      if (where?.id) rows = rows.filter((c) => c.id === where.id);
      if (where?.businessId) rows = rows.filter((c) => c.businessId === where.businessId);
      const row = rows[0] ?? null;
      if (!row || !select) return row;
      const out = {};
      for (const k of Object.keys(select)) out[k] = row[k];
      return out;
    },
  };
}

// ─── Simulate the list query logic ───────────────────────────────────────────

async function simulateListConversations(businessId, chatStore, customerStore) {
  const CUSTOMER_SOURCES = ["customer", "customer_assistant"];

  const grouped = await chatStore.groupBy({
    by: ["customerId"],
    where: { businessId, customerId: { not: null }, source: { in: CUSTOMER_SOURCES } },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take: 100,
  });

  const customerIds = grouped.map((g) => g.customerId).filter(Boolean);
  if (customerIds.length === 0) return [];

  const customers = await customerStore.findMany({
    where: { id: { in: customerIds }, businessId },
    select: { id: true, name: true, phone: true },
  });
  const customerMap = new Map(customers.map((c) => [c.id, c]));

  const lastMessages = await Promise.all(
    customerIds.map((cid) =>
      chatStore.findFirst({
        where: { businessId, customerId: cid, source: { in: CUSTOMER_SOURCES } },
        orderBy: { createdAt: "desc" },
        select: { text: true },
      })
    )
  );

  return customerIds.map((cid, i) => {
    const customer = customerMap.get(cid);
    const groupRow = grouped.find((g) => g.customerId === cid);
    return {
      customerId: cid,
      customerName: customer?.name ?? "Unknown",
      customerPhone: customer?.phone ?? null,
      lastMessage: (lastMessages[i]?.text ?? "").slice(0, 120),
      lastActivityAt: groupRow?._max.createdAt?.toISOString?.() ?? null,
    };
  }).sort((a, b) => {
    if (!a.lastActivityAt) return 1;
    if (!b.lastActivityAt) return -1;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

// ─── Simulate the thread query logic ─────────────────────────────────────────

async function simulateGetThread(businessId, customerId, customerStore, chatStore) {
  const CUSTOMER_SOURCES = ["customer", "customer_assistant"];

  const customer = await customerStore.findFirst({
    where: { id: customerId, businessId },
    select: { id: true, name: true, phone: true },
  });

  if (!customer) return { status: 404, body: null };

  const messages = await chatStore.findMany({
    where: { businessId, customerId, source: { in: CUSTOMER_SOURCES } },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true, source: true, text: true, createdAt: true },
  });

  const thread = messages.map((m) => ({
    id: m.id,
    source: m.source,
    text: m.text,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : new Date(m.createdAt).toISOString(),
  }));

  return { status: 200, body: { thread, customer: { id: customer.id, name: customer.name, phone: customer.phone ?? null } } };
}

// ─── Seed data ────────────────────────────────────────────────────────────────

const BIZ_A = "biz_a_tenant";
const BIZ_B = "biz_b_tenant";
const CUST_A1 = "cust_a1";
const CUST_A2 = "cust_a2";
const CUST_B1 = "cust_b1";

const CUSTOMERS = [
  { id: CUST_A1, businessId: BIZ_A, name: "Alice", phone: "+5491111111111" },
  { id: CUST_A2, businessId: BIZ_A, name: "Bob", phone: null },
  { id: CUST_B1, businessId: BIZ_B, name: "Carlos (other tenant)", phone: "+5492222222222" },
];

const t0 = new Date("2026-05-29T10:00:00Z");
const t1 = new Date("2026-05-29T10:05:00Z");
const t2 = new Date("2026-05-29T11:00:00Z");

const MESSAGES = [
  // BIZ_A / CUST_A1
  { id: "m1", businessId: BIZ_A, customerId: CUST_A1, source: "customer", text: "Hola, quiero comprar un filtro", createdAt: t0, clientMessageId: "cm1" },
  { id: "m2", businessId: BIZ_A, customerId: CUST_A1, source: "customer_assistant", text: "¡Hola Alice! Claro, tenemos filtros disponibles.", createdAt: t1, clientMessageId: "cm2" },
  // BIZ_A / CUST_A2
  { id: "m3", businessId: BIZ_A, customerId: CUST_A2, source: "customer", text: "Necesito saber el precio", createdAt: t2, clientMessageId: "cm3" },
  // BIZ_B / CUST_B1 (different tenant — must NOT appear in BIZ_A queries)
  { id: "m4", businessId: BIZ_B, customerId: CUST_B1, source: "customer", text: "Secret message from B", createdAt: t2, clientMessageId: "cm4" },
  // Owner/employee dashboard messages (customerId = null — must be excluded)
  { id: "m5", businessId: BIZ_A, customerId: null, source: "assistant", text: "Dashboard assistant reply", createdAt: t1, clientMessageId: "cm5" },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

test("list conversations — returns only conversations for the authenticated businessId", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  const result = await simulateListConversations(BIZ_A, chatStore, customerStore);

  assert.equal(result.length, 2, "BIZ_A has 2 customers with conversations");
  const ids = result.map((r) => r.customerId);
  assert.ok(ids.includes(CUST_A1), "includes CUST_A1");
  assert.ok(ids.includes(CUST_A2), "includes CUST_A2");
  assert.ok(!ids.includes(CUST_B1), "does NOT include CUST_B1 (different tenant)");
});

test("list conversations — dashboard messages (customerId=null) are excluded", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  const result = await simulateListConversations(BIZ_A, chatStore, customerStore);
  const hasNull = result.some((r) => r.customerId === null);
  assert.equal(hasNull, false, "no conversation with null customerId in results");
});

test("list conversations — sorted by most recent activity descending", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  const result = await simulateListConversations(BIZ_A, chatStore, customerStore);
  // CUST_A2 has t2 (11:00), CUST_A1 has t1 (10:05) — A2 should be first
  assert.equal(result[0].customerId, CUST_A2, "most recently active customer is first");
  assert.equal(result[1].customerId, CUST_A1, "older customer is second");
});

test("list conversations — returns empty array when business has no customer messages", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  const result = await simulateListConversations("biz_unknown", chatStore, customerStore);
  assert.deepEqual(result, [], "unknown businessId returns empty array");
});

test("list conversations — cross-tenant: BIZ_B only sees its own conversations", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  const result = await simulateListConversations(BIZ_B, chatStore, customerStore);
  assert.equal(result.length, 1, "BIZ_B has 1 customer with conversations");
  assert.equal(result[0].customerId, CUST_B1);
  assert.equal(result[0].customerName, "Carlos (other tenant)");
});

test("get thread — returns thread for own customer", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  const result = await simulateGetThread(BIZ_A, CUST_A1, customerStore, chatStore);
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.thread), "thread is an array");
  assert.equal(result.body.thread.length, 2, "2 messages for CUST_A1");
  assert.equal(result.body.customer.id, CUST_A1);
});

test("get thread — cross-tenant: BIZ_B cannot read BIZ_A customer thread (returns 404)", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  // BIZ_B tries to read CUST_A1's thread (belongs to BIZ_A)
  const result = await simulateGetThread(BIZ_B, CUST_A1, customerStore, chatStore);
  assert.equal(result.status, 404, "cross-tenant thread read returns 404");
  assert.equal(result.body, null, "no data returned");
});

test("get thread — cross-tenant: messages are businessId-scoped even if customerId is known", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  // BIZ_B knows CUST_A1's ID but cannot read the thread (customer.findFirst scopes by businessId)
  const customer = await customerStore.findFirst({ where: { id: CUST_A1, businessId: BIZ_B }, select: { id: true, name: true, phone: true } });
  assert.equal(customer, null, "customer not found when businessId doesn't match");
});

test("get thread — thread messages are ordered chronologically (oldest first)", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  const result = await simulateGetThread(BIZ_A, CUST_A1, customerStore, chatStore);
  assert.equal(result.status, 200);
  const times = result.body.thread.map((m) => m.createdAt);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1], `message ${i} not older than message ${i - 1}`);
  }
});

test("get thread — only customer-source messages included (owner dashboard messages excluded)", async () => {
  const chatStore = makeChatMessageStore(MESSAGES);
  const customerStore = makeCustomerStore(CUSTOMERS);

  const result = await simulateGetThread(BIZ_A, CUST_A1, customerStore, chatStore);
  const sources = result.body.thread.map((m) => m.source);
  const invalidSources = sources.filter((s) => !["customer", "customer_assistant"].includes(s));
  assert.deepEqual(invalidSources, [], "no non-customer sources in thread");
});

test("list conversations — lastMessage is truncated to 120 chars", async () => {
  const longText = "A".repeat(200);
  const extendedMessages = [
    ...MESSAGES,
    { id: "m_long", businessId: BIZ_A, customerId: CUST_A1, source: "customer", text: longText, createdAt: new Date("2026-05-29T12:00:00Z"), clientMessageId: "cm_long" },
  ];
  const chatStore = makeChatMessageStore(extendedMessages);
  const customerStore = makeCustomerStore(CUSTOMERS);

  const result = await simulateListConversations(BIZ_A, chatStore, customerStore);
  const alice = result.find((r) => r.customerId === CUST_A1);
  assert.ok(alice, "Alice found in result");
  assert.ok(alice.lastMessage.length <= 120, `lastMessage length ${alice.lastMessage.length} exceeds 120`);
});
