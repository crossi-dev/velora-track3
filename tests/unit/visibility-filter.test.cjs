const assert = require("node:assert/strict");
const test = require("node:test");

const {
  chatMessageVisibilityFilter,
  OWNER_VISIBLE,
  EMPLOYEE_VISIBLE,
} = require("../../src/app/api/business-assistant/_lib/visibility-filter.ts");

// ── chatMessageVisibilityFilter: owner ────────────────────────────────

test("owner: filter incluye 'public' y 'owner_only'", () => {
  const filter = chatMessageVisibilityFilter({ kind: "owner" });
  assert.deepEqual(filter, { visibility: { in: ["public", "owner_only"] }, customerId: null });
});

test("owner: filter NO incluye 'employee_only' (privacy del empleado, Brief Gap 1)", () => {
  const filter = chatMessageVisibilityFilter({ kind: "owner" });
  const allowed = filter.visibility.in;
  assert.equal(allowed.includes("employee_only"), false);
});

test("owner: filter excluye mensajes de hilo cliente (customerId: null)", () => {
  const filter = chatMessageVisibilityFilter({ kind: "owner" });
  // Customer WhatsApp thread messages have customerId set; dashboard must exclude them.
  assert.equal(filter.customerId, null);
});

test("owner: filter es deterministic — mismo input → mismo output (Set semantics)", () => {
  const a = chatMessageVisibilityFilter({ kind: "owner" });
  const b = chatMessageVisibilityFilter({ kind: "owner" });
  assert.deepEqual(a, b);
});

// ── chatMessageVisibilityFilter: employee ─────────────────────────────

test("employee: filter incluye 'public' y 'employee_only'", () => {
  const filter = chatMessageVisibilityFilter({ kind: "employee" });
  // Employee filter wraps visibility in AND to compose targetEmployeeId + customerId constraints
  const visibilities = (filter.AND?.[0] ?? filter)?.visibility?.in;
  assert.deepEqual(visibilities, ["public", "employee_only"]);
});

test("employee: filter NO incluye 'owner_only' (privacy del dueño)", () => {
  const filter = chatMessageVisibilityFilter({ kind: "employee" });
  const visibilities = (filter.AND?.[0] ?? filter)?.visibility?.in;
  assert.equal(visibilities.includes("owner_only"), false);
});

test("employee: filter excluye mensajes de hilo cliente (customerId: null en AND)", () => {
  const filter = chatMessageVisibilityFilter({ kind: "employee" });
  // Customer WhatsApp thread messages must not appear in companion chat.
  const customerIdClause = filter.AND?.find((clause) => "customerId" in clause);
  assert.ok(customerIdClause, "debe existir cláusula customerId en AND");
  assert.equal(customerIdClause.customerId, null);
});

// ── Cross-kind: owner y employee no se solapan ────────────────────────

test("owner y employee SOLO comparten 'public' (intersección)", () => {
  const ownerFilter = chatMessageVisibilityFilter({ kind: "owner" });
  const empFilter = chatMessageVisibilityFilter({ kind: "employee" });
  const ownerAllowed = ownerFilter.visibility.in;
  const empAllowed = (empFilter.AND?.[0] ?? empFilter)?.visibility?.in;
  const intersection = ownerAllowed.filter((v) => empAllowed.includes(v));
  assert.deepEqual(intersection, ["public"]);
});

// ── Constants exportadas ──────────────────────────────────────────────

test("OWNER_VISIBLE: ['public', 'owner_only']", () => {
  assert.deepEqual([...OWNER_VISIBLE], ["public", "owner_only"]);
});

test("EMPLOYEE_VISIBLE: ['public', 'employee_only']", () => {
  assert.deepEqual([...EMPLOYEE_VISIBLE], ["public", "employee_only"]);
});

test("constantes coinciden con el shape del filter (owner)", () => {
  const filter = chatMessageVisibilityFilter({ kind: "owner" });
  assert.deepEqual(filter.visibility.in, [...OWNER_VISIBLE]);
});

test("constantes coinciden con el shape del filter (employee)", () => {
  const filter = chatMessageVisibilityFilter({ kind: "employee" });
  const visibilities = (filter.AND?.[0] ?? filter)?.visibility?.in;
  assert.deepEqual(visibilities, [...EMPLOYEE_VISIBLE]);
});

// ── Property: el filter es siempre composable con businessId ─────────

test("filter compone con otros campos sin pisarse", () => {
  const businessId = "biz_123";
  const composedOwner = {
    businessId,
    kind: { not: "chat_reset" },
    ...chatMessageVisibilityFilter({ kind: "owner" }),
  };
  assert.equal(composedOwner.businessId, "biz_123");
  assert.deepEqual(composedOwner.kind, { not: "chat_reset" });
  assert.deepEqual(composedOwner.visibility, { in: ["public", "owner_only"] });

  const empFilter = chatMessageVisibilityFilter({ kind: "employee" });
  const composedEmp = { businessId, ...empFilter };
  // Employee filter uses AND; visibility lives in the first AND clause
  const empVisibilities = (empFilter.AND?.[0] ?? empFilter)?.visibility?.in;
  assert.deepEqual(empVisibilities, ["public", "employee_only"]);
  assert.equal(composedEmp.businessId, "biz_123");
});
