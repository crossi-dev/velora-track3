const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectIncompleteIntent,
} = require("../../src/app/dashboard/lib/incomplete-intent-clarification.ts");

// ─── Sale-verb solo (debe devolver clarification) ───────────────────

test("detectIncompleteIntent: 'vendí' solo → pide producto y cantidad", () => {
  const result = detectIncompleteIntent("vendí");
  assert.ok(result);
  assert.match(result.message, /qué vendiste/i);
  assert.match(result.message, /cantidad/i);
});

test("detectIncompleteIntent: 'vendi' sin acento → mismo resultado (normalización)", () => {
  const result = detectIncompleteIntent("vendi");
  assert.ok(result);
  assert.match(result.message, /qué vendiste/i);
});

test("detectIncompleteIntent: 'Vendele' (mayúscula) → mismo resultado", () => {
  const result = detectIncompleteIntent("Vendele");
  assert.ok(result);
});

test("detectIncompleteIntent: 'vendí.' con punto final (dictado STT) → mismo resultado", () => {
  const result = detectIncompleteIntent("vendí.");
  assert.ok(result);
});

test("detectIncompleteIntent: 'facturá' solo → pide clarificación", () => {
  const result = detectIncompleteIntent("facturá");
  assert.ok(result);
});

test("detectIncompleteIntent: 'anotame' solo → pide clarificación", () => {
  const result = detectIncompleteIntent("anotame");
  assert.ok(result);
});

test("detectIncompleteIntent: whitespace alrededor del verbo no rompe", () => {
  const result = detectIncompleteIntent("   vendí   ");
  assert.ok(result);
});

// ─── Casos que NO deben pedir clarificación ─────────────────────────

test("detectIncompleteIntent: 'vendí 2 cocas' (con items) → null (parser handles)", () => {
  assert.equal(detectIncompleteIntent("vendí 2 cocas"), null);
});

test("detectIncompleteIntent: 'vendí 2 cocas a Juan' (completo) → null", () => {
  assert.equal(detectIncompleteIntent("vendí 2 cocas a Juan"), null);
});

test("detectIncompleteIntent: 'vendí algo' (con texto trailing aunque sea ambiguo) → null", () => {
  // El parser puede manejar este caso o caer a no-match → AI; no es nuestro scope.
  assert.equal(detectIncompleteIntent("vendí algo"), null);
});

test("detectIncompleteIntent: input vacío → null", () => {
  assert.equal(detectIncompleteIntent(""), null);
  assert.equal(detectIncompleteIntent("   "), null);
});

test("detectIncompleteIntent: no-string → null (defensivo)", () => {
  assert.equal(detectIncompleteIntent(null), null);
  assert.equal(detectIncompleteIntent(undefined), null);
  assert.equal(detectIncompleteIntent(123), null);
});

test("detectIncompleteIntent: verbo no-venta (ej. 'cargá') → null", () => {
  // Otros verbos incompletos pueden agregarse en iteraciones futuras.
  // Acá solo cubrimos el caso del audit (vendí solo).
  assert.equal(detectIncompleteIntent("cargá"), null);
  assert.equal(detectIncompleteIntent("ajustá"), null);
});

test("detectIncompleteIntent: query genuina (no comando) → null", () => {
  assert.equal(detectIncompleteIntent("hola"), null);
  assert.equal(detectIncompleteIntent("cuanto stock tengo"), null);
  assert.equal(detectIncompleteIntent("¿qué vendiste hoy?"), null);
});

test("detectIncompleteIntent: el ejemplo del mensaje incluye comillas alrededor del input sugerido", () => {
  // Pin del formato exacto — el ejemplo "vendí 2 cocas a 1500" enseña
  // al usuario el shape del comando (verbo + cantidad + producto + monto).
  const result = detectIncompleteIntent("vendí");
  assert.ok(result);
  assert.match(result.message, /"vendí 2 cocas a 1500"/);
});
