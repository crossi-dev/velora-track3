const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildProductDeleteConfirmCopy,
} = require("../../src/app/dashboard/lib/product-delete-copy.ts");

test("buildProductDeleteConfirmCopy: producto sin ventas usa copy estándar y tono no neutro", () => {
  const copy = buildProductDeleteConfirmCopy(false);
  assert.equal(copy.message, "¿Eliminar este producto?");
  assert.equal(copy.confirmLabel, "Sí, eliminar");
  assert.equal(copy.neutralTone, false);
});

test("buildProductDeleteConfirmCopy: producto con ventas usa copy con aviso y tono neutro", () => {
  const copy = buildProductDeleteConfirmCopy(true);
  assert.equal(copy.message, "Este producto tiene ventas registradas. ¿Borrarlo igual?");
  assert.equal(copy.confirmLabel, "Borrar");
  assert.equal(copy.neutralTone, true);
});

test("buildProductDeleteConfirmCopy: la copy con ventas no usa lenguaje alarmista", () => {
  const copy = buildProductDeleteConfirmCopy(true);
  // No "atención", no "advertencia", no "cuidado", no "irreversible"
  assert.doesNotMatch(copy.message, /atenci[oó]n|advertencia|cuidado|irreversible/i);
});

test("buildProductDeleteConfirmCopy: el confirmLabel siempre es accionable, no genérico", () => {
  // "Sí" o "Borrar" — pero no "OK" ni "Aceptar" (genéricos sin contexto)
  for (const hasSales of [true, false]) {
    const copy = buildProductDeleteConfirmCopy(hasSales);
    assert.doesNotMatch(copy.confirmLabel, /^(OK|Aceptar)$/i);
  }
});
