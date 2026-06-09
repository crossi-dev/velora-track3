// T5d parser — detecta si el dueño quiere cargar otro producto o terminar
// después de confirmar el stock inicial (T5c). Separado de parsers.ts para
// mantener ese archivo bajo 300 líneas.

import { normalizeForMatching } from "@/lib/normalize";

export type T5dChoice = "continue" | "finish";

const T5D_CONTINUE_VALUES = new Set([
  "otro", "cargo otro", "agrego otro", "agrego mas", "siguiente", "otro producto", "mas",
]);
const T5D_FINISH_VALUES = new Set([
  "listo", "ya esta", "arrancamos", "termino", "basta", "es todo", "no", "ya", "fin",
  "ya termino", "no mas", "ninguno mas",
]);

const T5D_CONTINUE_PATTERNS: RegExp[] = [
  /\botro\b/, /\bcargo otro\b/, /\bagrego\b/, /\bsiguiente\b/, /\bmas producto/,
  /\buno mas\b/, /\bpuedo cargar\b/,
];
const T5D_FINISH_PATTERNS: RegExp[] = [
  /\blisto\b/, /\bya esta\b/, /\barrancamos\b/, /\btermin[oa]\b/, /\bes todo\b/,
  /\bno mas\b/, /\bempezar a vender\b/, /\bcomenz[ao]r\b/,
];

/**
 * Detecta si el dueño quiere continuar cargando otro producto ("otro") o
 * terminar ("listo"). Se dispara en turn 6 (T5d), ANTES de parseStockQuantityResponse,
 * para que "listo" / "otro" no se interpreten como cantidades.
 * Devuelve null si el input no cae en ninguna categoría.
 */
export function detectT5dChoice(text: string): T5dChoice | null {
  const normalized = normalizeForMatching(text).trim();
  if (!normalized) return null;
  if (T5D_CONTINUE_VALUES.has(normalized)) return "continue";
  if (T5D_FINISH_VALUES.has(normalized)) return "finish";
  if (T5D_CONTINUE_PATTERNS.some((re) => re.test(normalized))) return "continue";
  if (T5D_FINISH_PATTERNS.some((re) => re.test(normalized))) return "finish";
  return null;
}
