const assert = require("node:assert/strict");
const test = require("node:test");

// Stub env vars antes de importar — el módulo bajo test pulls prisma vía
// supervisor route. Solo testeamos la heurística pura `shouldBypassToSupervisor`.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-not-for-production";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";

const { shouldBypassToSupervisor } = require("../../src/app/api/supervisor/_lib/bypass-heuristics.ts");

// ── Length-based bypass ────────────────────────────────────────────────

test("bypass: input > 240 chars → true", () => {
  const long = "a".repeat(250);
  assert.equal(shouldBypassToSupervisor(long), true);
});

test("no bypass: input corto sin signals → false", () => {
  assert.equal(shouldBypassToSupervisor("hola"), false);
  assert.equal(shouldBypassToSupervisor("vendí 2 lattes"), false);
});

// ── Conditional bypass ────────────────────────────────────────────────

test("bypass: condicional 'si X entonces Y' → true", () => {
  assert.equal(shouldBypassToSupervisor("si me llegan los clavos entonces cargá 50"), true);
});

test("bypass: 'cuando X hacé Y' → true", () => {
  assert.equal(shouldBypassToSupervisor("cuando se acabe el azúcar hacé pedido al proveedor"), true);
});

// ── Multi-step "y" connector bypass ───────────────────────────────────

test("bypass: 3+ 'y' como conectores → true", () => {
  assert.equal(shouldBypassToSupervisor("vendí remera y cargá pantalón y subí precio y avisá"), true);
});

test("no bypass: solo 1 'y' como conector → false (sin otros signals)", () => {
  assert.equal(shouldBypassToSupervisor("vendí 2 lattes y 1 medialuna"), false);
});

// ── Config keyword bypass (NUEVO) ──────────────────────────────────────

test("bypass: palabra 'regla' → true", () => {
  assert.equal(shouldBypassToSupervisor("acordate de la regla de lavar manos"), true);
});


test("bypass: 'cada N hs' → true", () => {
  assert.equal(shouldBypassToSupervisor("lavate las manos cada 2 horas"), true);
});

test("bypass: 'siempre' como directiva → true", () => {
  assert.equal(shouldBypassToSupervisor("siempre saludá al cliente que entra"), true);
});

test("bypass: 'horario' → true", () => {
  assert.equal(shouldBypassToSupervisor("desde mañana cambio el horario de apertura"), true);
});

test("bypass: 'política' → true", () => {
  assert.equal(shouldBypassToSupervisor("nueva política de cambios: hasta 7 días"), true);
});

test("bypass: 'mandale a los chicos que' → true", () => {
  assert.equal(shouldBypassToSupervisor("mandale a los chicos que no falten el lunes"), true);
});

test("bypass: 'acordate de decirle' → true", () => {
  assert.equal(shouldBypassToSupervisor("acordate de decirle a los chicos que cierren temprano"), true);
});

// ── Caso real del founder ──────────────────────────────────────────────

test("bypass: ejemplo real del founder con cafés + regla condicional → true (vía 'acordate de decirle')", () => {
  const realInput = "Che, a partir de mañana todos los cafés suben 500 pesos, y acordate de decirle a los chicos que cierren temprano porque se me complica la caja";
  assert.equal(shouldBypassToSupervisor(realInput), true);
});

// ── No bypass cuando es operación pura ────────────────────────────────

test("no bypass: 'vendí 3 lattes a Juan' → false (operación normal)", () => {
  assert.equal(shouldBypassToSupervisor("vendí 3 lattes a Juan"), false);
});

test("no bypass: 'cuánto vendí hoy' → false (consulta simple)", () => {
  assert.equal(shouldBypassToSupervisor("cuánto vendí hoy"), false);
});

test("no bypass: 'pagué la luz 5000' → false (movimiento simple)", () => {
  assert.equal(shouldBypassToSupervisor("pagué la luz 5000"), false);
});

// ── Edge cases ────────────────────────────────────────────────────────

test("no bypass: input vacío → false", () => {
  assert.equal(shouldBypassToSupervisor(""), false);
  assert.equal(shouldBypassToSupervisor("   "), false);
});

test("bypass: 'cada' sin número no dispara solo (necesita un número después)", () => {
  // "cada hora" debe disparar (regex usa \d, "cada\s+\d") - NO debe disparar
  assert.equal(shouldBypassToSupervisor("cada hora hacé X"), false);
  // "cada 1 hora" sí
  assert.equal(shouldBypassToSupervisor("cada 1 hora hacé X"), true);
});

