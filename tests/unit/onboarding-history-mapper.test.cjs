// Unit tests for mapRecentHistory in owner-handler.stages-onboarding-agent.ts.
//
// Regression guard for the ONBOARDING_HISTORY_UNKNOWN_KIND bug:
// buildRecentHistory (route-history-filter.ts) outputs PendingConfirmationCarrier[]
// with `role: "user" | "assistant"`. Before the fix, mapRecentHistory read
// `h.kind` (always undefined on those objects), causing all 6 history entries
// to be dropped with ONBOARDING_HISTORY_UNKNOWN_KIND on every invocation.
// After the fix it reads `h.role` and maps correctly.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  mapRecentHistory,
} = require(
  "../../src/app/api/business-assistant/_lib/owner-handler.stages-onboarding-agent.ts",
);

test("mapRecentHistory: role=user maps to owner", () => {
  const result = mapRecentHistory([{ role: "user", text: "Hola" }]);
  assert.deepEqual(result, [{ role: "owner", text: "Hola" }]);
});

test("mapRecentHistory: role=assistant maps to assistant", () => {
  const result = mapRecentHistory([{ role: "assistant", text: "¿Cuál es tu nombre?" }]);
  assert.deepEqual(result, [{ role: "assistant", text: "¿Cuál es tu nombre?" }]);
});

test("mapRecentHistory: mixed roles map correctly", () => {
  const input = [
    { role: "user", text: "Mi negocio se llama Velora" },
    { role: "assistant", text: "Perfecto, ¿cuál es tu método de pago?" },
    { role: "user", text: "Efectivo" },
  ];
  const result = mapRecentHistory(input);
  assert.deepEqual(result, [
    { role: "owner", text: "Mi negocio se llama Velora" },
    { role: "assistant", text: "Perfecto, ¿cuál es tu método de pago?" },
    { role: "owner", text: "Efectivo" },
  ]);
});

test("mapRecentHistory: undefined role is dropped (no crash)", () => {
  // This is the exact shape that caused the bug — kind was set, role was undefined.
  // After the fix, role=undefined is dropped gracefully.
  const input = [
    { role: undefined, text: "algún texto" },
    { role: "user", text: "texto válido" },
  ];
  const result = mapRecentHistory(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { role: "owner", text: "texto válido" });
});

test("mapRecentHistory: empty array returns empty", () => {
  assert.deepEqual(mapRecentHistory([]), []);
});

test("mapRecentHistory: undefined input returns empty", () => {
  assert.deepEqual(mapRecentHistory(undefined), []);
});

test("mapRecentHistory: caps at last 6 entries", () => {
  const input = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `msg-${i}`,
  }));
  const result = mapRecentHistory(input);
  assert.equal(result.length, 6);
  // Should be the last 6 items from input (indices 4–9).
  assert.equal(result[0].text, "msg-4");
  assert.equal(result[5].text, "msg-9");
});

test("mapRecentHistory: missing text defaults to empty string", () => {
  const result = mapRecentHistory([{ role: "user" }]);
  assert.deepEqual(result, [{ role: "owner", text: "" }]);
});
