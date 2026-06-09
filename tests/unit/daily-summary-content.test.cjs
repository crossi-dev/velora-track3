const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatDailySummaryMessage,
} = require("../../src/app/api/_lib/daily-summary-content.ts");

test("formatDailySummaryMessage: con ventas y gastos arma cobraste/gastaste/neto", () => {
  // Post-03987f26: brand voice rewrite. Title is now "Velora · Resumen del día"
  // (no business name). Body uses "Hoy cobraste / gastaste. Neto:" pattern.
  const out = formatDailySummaryMessage({
    sales: 12000,
    expenses: 3500,
    net: 8500,
    businessName: "Ferretería Don Pepe",
    currency: "ARS",
  });
  assert.ok(out);
  assert.equal(out.title, "Velora · Resumen del día");
  assert.match(out.body, /cobraste/);
  assert.match(out.body, /gastaste/);
  assert.match(out.body, /Neto:/);
  assert.equal(out.url, "/dashboard?tab=sales");
});

test("formatDailySummaryMessage: con solo ventas (gastos=0) arma cobraste sin gastaste/neto", () => {
  // Post-03987f26: zero-expense path uses a shorter celebratory body
  // ("Hoy cobraste $X en {name}. ¡Buen día!") — no gastos line, no Neto line.
  const out = formatDailySummaryMessage({
    sales: 5000,
    expenses: 0,
    net: 5000,
    businessName: "Test",
    currency: "ARS",
  });
  assert.ok(out);
  assert.match(out.body, /cobraste/);
  assert.doesNotMatch(out.body, /gastaste/);
  assert.doesNotMatch(out.body, /Neto/);
});

test("formatDailySummaryMessage: sin ventas (sales=0) devuelve null aunque haya gastos", () => {
  const out = formatDailySummaryMessage({
    sales: 0,
    expenses: 4000,
    net: -4000,
    businessName: "Test",
    currency: "ARS",
  });
  assert.equal(out, null);
});

test("formatDailySummaryMessage: ventas negativas (anomalía) tampoco generan mensaje", () => {
  const out = formatDailySummaryMessage({
    sales: -100,
    expenses: 0,
    net: -100,
    businessName: "Test",
    currency: "ARS",
  });
  assert.equal(out, null);
});

test("formatDailySummaryMessage: net negativo (gastó más de lo que vendió) muestra signo en Neto", () => {
  // Post-03987f26: body pattern is "Neto: -$X." (not "Te quedó -$X").
  const out = formatDailySummaryMessage({
    sales: 1000,
    expenses: 2500,
    net: -1500,
    businessName: "Test",
    currency: "ARS",
  });
  assert.ok(out);
  assert.match(out.body, /Neto: -/);
});

test("formatDailySummaryMessage: currency inválida (string vacío) cae a fallback con $ sin tirar", () => {
  const out = formatDailySummaryMessage({
    sales: 500,
    expenses: 0,
    net: 500,
    businessName: "Test",
    currency: "",
  });
  assert.ok(out);
  // El fallback usa $ + número formateado es-AR
  assert.match(out.body, /\$/);
});
