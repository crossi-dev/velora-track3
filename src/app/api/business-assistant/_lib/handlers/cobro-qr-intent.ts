import { normalizeForMatching } from "../shared";
import { parseARAmount } from "@/lib/parse-ar-amount";
import type { CobroMetodo } from "../nlu/types";

// Detector determinístico para el intent `cobro_qr`.
//
// Reconoce frases del empleado tipo:
//   - "cobro QR 5000"               → metodo "qr"
//   - "cobro 5000"                  → metodo "qr" (default cuando solo viene monto)
//   - "qr 5000"                     → metodo "qr"
//   - "cobro QR 5000 a Carlos"      → metodo "qr" (bindea cliente del catálogo)
//   - "cobro alias 5000"            → metodo "alias"
//   - "cobro 5000 alias"            → metodo "alias" (orden flexible)
//   - "transferencia 5000"          → metodo "alias"
//   - "cobrame 5000 alias"          → metodo "alias"
//
// Reglas (en orden):
//   1. Rechaza input vacío.
//   2. Rechaza frases con verbo de venta (`vendí`, `vende`, etc.) — el intent
//      correcto es sale_create o sale_send. Defensa ante números de teléfono
//      que el LLM podría malinterpretar como montos.
//   3. Rechaza preguntas ("cómo cobro", "cuánto cobro", "por qué cobro").
//      El detector es para acción, no para Q&A — esas van al LLM.
//   4. Requiere un verbo/keyword: `cobro` (palabra suelta, NO `cobrale`),
//      `qr`, `cobrame` o `transferencia`.
//   5. Extrae candidatos numéricos y descarta:
//      (a) Números ≥10 dígitos consecutivos (teléfonos AR: 10-13 dígitos;
//          los precios argentinos rara vez superan 9 dígitos = mil millones).
//      (b) Números precedidos por palabra señal de teléfono (telefono, tel,
//          cel, celular, movil, whatsapp, wpp, wsp, numero).
//      Del resto toma el mayor como monto. Sin monto válido, null.
//   6. Resuelve el método: si aparece "alias" o "transferencia" → "alias",
//      caso contrario "qr" (default — preserva backward compatibility).
//   7. Opcionalmente bindea cliente del catálogo si el texto normalizado
//      contiene el nombre normalizado de un customer.

export interface CobroQrDetection {
  metodo: CobroMetodo;
  monto: number;
  matchedCustomerId: string | null;
  customerName: string | null;
}

interface CustomerLite {
  id: string;
  name: string;
}

// Keywords que indican que el usuario está PREGUNTANDO en vez de ordenando.
// Si aparece alguno, no hay action — cae al LLM como business_query.
const QUESTION_PATTERNS = [
  "como ",
  " como",
  "cuanto ",
  " cuanto",
  "por que ",
  " por que",
];

// Verbos de venta que pertenecen a sale_create/sale_send — no a cobro_qr.
// Si el texto incluye uno de estos, la intención es registrar una venta,
// no generar un QR de cobro. Rechazar aquí evita que el LLM interprete
// un número de teléfono como monto de cobro en frases como
// "vendí 1 alfajor a Carlos telefono 1100000000".
// Se evalúa sobre texto ya normalizado (sin acentos, lowercase).
const SALE_VERB_RE = /\b(vendi|vende|vendo|vender|vendele|vendile|venta\s+de)\b/;

// Verbos válidos para el camino QR/alias genérico: formas de `cobrar`
// standalone (sin cliente explícito), `qr` standalone, o `transferencia`.
// `cobr[eoaéóá]\w*` cubre cobro/cobré/cobra/cobrar/cobramos.
const COBRO_VERB_RE = /\b(cobr[eoaéóá]\w*|qr|transferencia)\b/;

// `cobrale|cobrales|cobrá|cobra` — admitidos SOLO cuando el texto también
// menciona "alias" o "transferencia". De lo contrario pertenecen a sale_send
// ("cobrale 5000 a juan" = registrar venta + enviar comprobante).
const COBRALE_ALIAS_RE = /\b(cobrale|cobrales|cobra(?:le)?)\b/;

// Excluye `cobrale` explícitamente del camino QR (sin keyword alias).
// Solo se saltea si el texto también contiene el trigger de alias.
const SALE_SEND_VERB_RE = /\bcobrale|cobrales\b/;

// Disparadores del modo alias: aparición explícita de "alias" o "transferencia".
const ALIAS_MODE_RE = /\b(alias|transferencia)\b/;

// Palabras señal que indican que el número siguiente es un teléfono.
// Deben aparecer como palabras completas (word boundary) inmediatamente
// antes del número (con espacio). Cubren formas cortas y largas de AR.
const PHONE_SIGNAL_WORDS = new Set([
  "telefono", "tel", "cel", "celular", "movil", "numero", "num",
  "whatsapp", "wpp", "wsp", "wa", "wapp", "guasap",
]);

// Longitud mínima de dígitos consecutivos para asumir que un número es
// un teléfono (no un precio). Los números de teléfono AR tienen 10-13 dígitos.
// Los precios argentinos rara vez superan 9 dígitos (= 999.999.999 ARS).
const PHONE_DIGIT_THRESHOLD = 10;

/**
 * Checks whether a digit sequence at `matchIndex` in `normalized` is
 * preceded (within the same word-token boundary) by a phone signal word.
 * The word immediately before the number must be in PHONE_SIGNAL_WORDS.
 */
function isPrecededByPhoneSignal(normalized: string, matchIndex: number): boolean {
  // Walk back past optional whitespace to find the preceding word.
  let i = matchIndex - 1;
  while (i >= 0 && normalized[i] === " ") i--;
  if (i < 0) return false;
  const end = i + 1;
  while (i > 0 && normalized[i - 1] !== " ") i--;
  const prevWord = normalized.slice(i, end);
  return PHONE_SIGNAL_WORDS.has(prevWord);
}

export function looksLikeCobroQrIntent(
  text: string,
  customers: CustomerLite[],
): CobroQrDetection | null {
  if (!text || text.trim().length === 0) return null;

  const normalized = normalizeForMatching(text);

  // 1. Si el texto tiene un verbo de venta, el intent correcto es sale_create/
  //    sale_send — nunca cobro_qr. Esto previene que el número de teléfono del
  //    cliente sea capturado como monto ("vendí 1 alfajor a Carlos tel 1100000000").
  if (SALE_VERB_RE.test(normalized)) return null;

  // 2. Si dice `cobrale/cobrales` SIN keyword de alias, dejar pasar a sale_send.
  //    Con keyword de alias ("cobrale 5000 a juan por transferencia") sí es nuestro
  //    intent — el owner quiere cobrar por alias, no registrar una venta.
  if (SALE_SEND_VERB_RE.test(normalized) && !ALIAS_MODE_RE.test(normalized)) return null;

  // 3. Rechazar preguntas — intent es ACCIÓN, no Q&A.
  for (const q of QUESTION_PATTERNS) {
    if (normalized.includes(q)) return null;
  }

  // 4. Requerir verbo/keyword válido.
  //    `cobrale/cobrales` con alias también son verbos válidos para esta rama.
  if (!COBRO_VERB_RE.test(normalized) && !COBRALE_ALIAS_RE.test(normalized)) return null;

  // 5. Extraer candidatos numéricos descartando teléfonos.
  //    (a) Números ≥PHONE_DIGIT_THRESHOLD dígitos consecutivos → teléfono.
  //    (b) Números precedidos por palabra señal de teléfono → teléfono.
  //    Del resto toma el mayor como monto.
  //
  //    Nota histórica: match(/(\d+)/) tomaba el PRIMER número, no el monto real.
  //    "cobro 3 meses 5000" devolvía monto=3. Se usa Math.max sobre candidatos
  //    válidos (ya existía). Este paso ADEMÁS descarta números-teléfono.
  // Capture FULL money tokens (with AR separators / k-suffix), not bare digit
  // runs — "5.000" must parse as 5000, not split into "5" + "000" (which gave
  // monto=5). parseARAmount is the canonical AR-peso parser.
  const amountCandidates: number[] = [];
  for (const m of normalized.matchAll(/\$?\s*(\d[\d.,]*(?:[kK])?)/g)) {
    const token = m[1];
    const digitCount = (token.match(/\d/g) ?? []).length;
    if (digitCount === 0) continue;
    // Descarta por longitud (teléfono AR: 10+ dígitos — un monto rara vez supera
    // 9 dígitos = mil millones). Cuenta dígitos del token (ignora separadores).
    if (digitCount >= PHONE_DIGIT_THRESHOLD) continue;
    // Descarta por contexto: palabra anterior es señal de teléfono.
    if (isPrecededByPhoneSignal(normalized, m.index ?? 0)) continue;
    const value = parseARAmount(token);
    if (value !== null && value >= 1) amountCandidates.push(value);
  }
  if (amountCandidates.length === 0) return null;
  const monto = Math.max(...amountCandidates);
  if (!Number.isFinite(monto) || monto < 1) return null;

  // 6. Resolver método: alias o qr (default).
  const metodo: CobroMetodo = ALIAS_MODE_RE.test(normalized) ? "alias" : "qr";

  // 7. Opcional: bindear cliente del catálogo.
  let matchedCustomerId: string | null = null;
  let customerName: string | null = null;
  // Ordenamos del nombre normalizado más largo al más corto para preferir
  // matches específicos sobre genéricos (ej. "Carlos Rossi" antes que "Carlos").
  const sortedCustomers = customers
    .map((c) => ({ id: c.id, name: c.name, normalized: normalizeForMatching(c.name) }))
    .filter((c) => c.normalized.length >= 2)
    .sort((a, b) => b.normalized.length - a.normalized.length);

  for (const c of sortedCustomers) {
    if (normalized.includes(c.normalized)) {
      matchedCustomerId = c.id;
      customerName = c.name;
      break;
    }
  }

  return { metodo, monto, matchedCustomerId, customerName };
}
