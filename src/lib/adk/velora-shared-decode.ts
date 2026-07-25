// Shared decode block — Argentinismos + speech-to-text errors + decode entre líneas.
// Single source of truth. The supervisor (router) and every operational sub-agent
// (Ventas, Equipo when un-shelved, etc.) import this constant so changes to
// the dueño's slang/voice transcripts propagate uniformly.
//
// Why this lives here (and not inline per agent): without a shared module the
// decode block was duplicated in supervisor-prompt.ts + ventas-agent-helpers.ts
// and was drifting (the supervisor knew "qué se está volando" but Ventas did
// not). A single import + concatenation guarantees consistency at zero runtime
// cost (the LLM still sees the same text per agent — savings are mantenimiento +
// drift prevention, NOT input tokens per call).

export const VELORA_DECODE_BLOCK = `COMPRENSIÓN DEL DUEÑO — ARGENTINISMOS:
El dueño habla rápido, informal, rioplatense. Decodificá antes de parsear:
- "los chicos" / "el equipo" / "los pibes" = los empleados.
- "la caja" = saldo de caja / cashBalance.
- "ponele X pesos" / "poné X" = setear precio a X → edit_product.
- "subí X%" / "aumentá X%" = bulk_price_update, direction: "up", percentage.
- "bajá X%" / "rebajá X%" = bulk_price_update, direction: "down", percentage.
- "subí X pesos" / "subí una luca" = bulk_price_update, direction: "up", absolute.
- "todos" / "todo el catálogo" = target: "all" en bulk_price_update.
- "cargá X al catálogo" / "agregá X" = create_product.
- "sacá X" / "borrá X del catálogo" = delete_product.
- "cuánto hice" / "cuánto vendí" = consulta de ventas → kind:"answer".
- "qué me quedó" / "cómo está el stock" = consulta de inventario → kind:"answer".
- "qué se está volando" / "qué se vende más" / "los más vendidos" / "qué vuela más" = consulta de velocidad de ventas → kind:"answer". NO listés el inventario completo. El historial de ventas NO está en el contexto — respondé: "Para ver los productos que más se venden entrá a Reportes → Productos. En este momento el contexto solo tiene niveles de stock, no historial de ventas." Si el contexto muestra productos con stock muy bajo, podés agregarlos como dato de referencia.
- "luca" = 1000 pesos. "dos lucas" = 2000. "media luca" = 500. "mangos" = pesos.
- Números escritos: uno=1, dos=2, tres=3, cinco=5, diez=10, veinte=20, cincuenta=50, cien=100, mil=1000.

COMPRENSIÓN DEL DUEÑO — ERRORES DE VOZ (speech-to-text):
El dueño también dicta por voz. Las transcripciones pueden tener errores:
- "porcentaje" / "por ciento" = %. "cinco por ciento" = 5%. "diez por ciento" = 10%.
- "subí" puede llegar como "subi", "subile", "subi le". "bajá" como "baja", "bajale".
- Nombres de productos pueden estar mal escritos. Buscá coincidencias aproximadas en el catálogo.
- Si el mensaje es incoherente pero tiene palabra clave clara (subí, borrá, ponele), intentá interpretar.
- Si hay ambigüedad real después de interpretar → ASK, NEVER ASSUME. kind:"clarification".

COMPRENSIÓN DEL DUEÑO — DECODE ENTRE LÍNEAS:
- "los chicos" + acción = regla para empleados (business_rule).
- "que saluden cuando entra alguien" → behavior-based rule, trigger="greet_customer_entry".
- "subí todo" sin monto → kind:"clarification": "¿Cuánto subís: porcentaje o monto fijo?"
- "sacá lo que no vendo" → kind:"clarification": "¿Cuáles productos querés dar de baja?"
- "ponele precio a todo" → kind:"clarification": "¿A qué precio?"
- "qué anda mal" / "cómo estamos" → kind:"answer" con resumen del contexto disponible.
- Directiva vaga sin condición concreta → SIEMPRE kind:"clarification".`;
