import { normalizeForMatching } from "@/lib/normalize";

// franchise-guards.ts — clasificadores de modo franquicia estricto para el Companion.
//
// Dos heurísticas simples aplicadas en preFilterStage antes de llegar al LLM:
//   1. FRANCHISE_AUTH_REQUEST: el empleado pide autorización explícita (→ B1 escalation).
//   2. isNarrativeComment: el empleado narra algo no operativo (→ EmployeeNote).

// Authorization request: employee is ASKING permission for something.
export const FRANCHISE_AUTH_REQUEST =
  /\b(puedo|me pod[eé]s|pod[eé]s|me autoriz[aá]s|autoriz[aá]s|me permit[ií]s|necesito permiso|pedir permiso|d[eé]jame|me dej[aá]s|le hago|acepto|agarro|aplico)\b.{0,60}\b(descuento|devoluci[oó]n|devolver|precio|cambio|ajuste|regalo|bonif|rebaja)\b/i;

// Narrative comment: employee is REPORTING something, not requesting action.
// Positive signal: >15 chars without any operational verb mapping to a fast-path intent.
const OPERATIONAL_VERBS =
  /\b(vend[ií]|cobr[aá]|factur[aá]|registr[aá]|carg[aá]|ingres[aá]|stock|precio|cuánto|cuánta|cuántos|cuántas|hay|quedan|vale|sale|cuesta|clientes?|proveedor)\b/i;

export function isNarrativeComment(text: string): boolean {
  if (text.length <= 15) return false;
  if (OPERATIONAL_VERBS.test(text)) return false;
  return true;
}

// ─── Operational question detector (Behaviour 5b) ────────────────────────────
//
// Detects when the employee is asking a HOW/WHAT-TO-DO question rather than
// executing an operation. These must be answered by the Q&A stage, not
// dismissed as small talk or logged as narrative notes.
//
// Match patterns (AR-tuned):
//   - "cómo + operational verb" → "cómo cargo una venta", "cómo registro el stock"
//   - "qué hago si/cuando" → "qué hago cuando llega el proveedor"
//   - "qué hago con/en" → "qué hago con un cliente molesto"
//   - "se puede / puedo + operational verb + ?"  (without an auth-request noun)
//   - short how-to variants with question mark: "cómo se hace?", "cómo va?"

const OPERATIONAL_QUESTION_RE =
  /(\bcómo\b|\bcomo\b).{0,60}\b(cargo|registro|hago|guardo|envío|envio|mando|creo|abro|cierro|proceso|anoto|reporto|consulto|veo|busco)\b/i;
const WHAT_TO_DO_RE =
  /\bqué\s+hago\b|\bque\s+hago\b/i;
const PROCEDURAL_QUESTION_RE =
  /\b(cómo\s+(se\s+)?(hace|hago|cargo|registro|consulto|veo|envío|funciona)|qué\s+hago\s+(si|cuando|con|en)|qué\s+tengo\s+que\s+hacer)\b/i;

export interface OperationalQuestionResult {
  isOperationalQuestion: boolean;
  questionType?: "sale" | "stock" | "customer" | "general";
}

export function isOperationalQuestion(text: string): OperationalQuestionResult {
  const lc = normalizeForMatching(text);

  const matched =
    OPERATIONAL_QUESTION_RE.test(lc) ||
    WHAT_TO_DO_RE.test(lc) ||
    PROCEDURAL_QUESTION_RE.test(lc);

  if (!matched) return { isOperationalQuestion: false };

  // Classify question type for richer context injection.
  if (/\b(venta|vender|cobrar|vendi|cobro|factura|registrar venta)\b/.test(lc)) {
    return { isOperationalQuestion: true, questionType: "sale" };
  }
  if (/\b(stock|inventario|carga|ingreso|mercaderia|reponer|proveedor)\b/.test(lc)) {
    return { isOperationalQuestion: true, questionType: "stock" };
  }
  if (/\b(cliente|clientes|crear cliente|cargar cliente|nuevo cliente)\b/.test(lc)) {
    return { isOperationalQuestion: true, questionType: "customer" };
  }
  return { isOperationalQuestion: true, questionType: "general" };
}

// Preamble injected at the top of the Companion system prompt.
// Kept here so it can evolve without touching the main 300-line prompt file.
export const FRANCHISE_SYSTEM_PREAMBLE = `CONTEXTO FRANQUICIA (REGLAS DURAS):
- Los precios son fijos. NUNCA cambies un precio ni aceptes negociación de precio del cliente.
  Si el cliente protesta el precio, respondé al empleado: "El precio es fijo según la marca.
  Si el cliente insiste, podés anotar el reclamo y se lo paso al dueño al cierre."
- Los descuentos solo los autoriza el dueño. NUNCA propongas un descuento por tu cuenta.
  Si el empleado pide hacer un descuento, escalá al dueño como pedido de autorización.
- Las devoluciones solo las autoriza el dueño. NUNCA confirmes una devolución sin
  autorización explícita. Si el empleado dice "quiero hacer una devolución" o el cliente
  pide devolver, tratalo como pedido de autorización y escalá al Supervisor (B1).
- Cambios de catálogo, alta de productos nuevos, modificación de reglas: solo el dueño.
  Nunca ejecutes ni prometas ejecutar ninguna de estas acciones.

CUÁNDO ESCALAR vs CUÁNDO ANOTAR:
- Si el empleado pide AUTORIZACIÓN ("¿puedo hacer X?", "necesito permiso para Y",
  "me autorizás", "¿le hago descuento?", "¿acepto la devolución?") →
  escalar al Supervisor vía B1/B2. Respondele al empleado:
  "Le consulté a tu jefe. Te aviso cuando te responda."
- Si el empleado COMENTA o NARRA algo no operativo ("el cliente está enojado",
  "vino un proveedor", "se rompió la heladera", "el freezer hace ruido") →
  ofrecer ANOTAR para el cierre. Respondele:
  "Anotado. Lo paso al dueño al cierre. ¿Querés agregar algo más?"
  Usá intent: "answer" y no ejecutes ninguna otra acción.
- Si la pregunta NO es operativa Y NO es nota relevante (small talk genuino:
  "gracias", "ok", "hola", "dale") → respondé corto y cálido, volvé al modo operativo.

CUÁNDO NO IMPROVISAR:
- Si no entendiste el pedido del empleado, NO inventes respuesta.
  Preguntá UNA aclaración corta o recordale las 5 operaciones que podés hacer:
  registrar venta, consultar stock, consultar precio, crear cliente o reportar un evento.

`;
