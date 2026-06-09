// T5 parser — cómo cargar el primer producto. Tres opciones canónicas para
// el demo (foto / archivo / manual) más "voz" legacy. Split out of
// onboarding-fast-path.parsers.ts to keep that file under the 300 LOC limit.

import { normalizeForMatching } from "@/lib/normalize";

const T5_FOTO_PATTERNS: RegExp[] = [
  /\bfoto\b/, /\bfotos\b/, /\bsaco foto\b/, /\bsacar foto\b/,
  /\bcuaderno\b/, /\bcamara\b/, /\bcámara\b/, /\betiquetas?\b/, /\bte muestro\b/,
];
const T5_ARCHIVO_PATTERNS: RegExp[] = [
  /\barchivo\b/, /\bexcel\b/, /\bcsv\b/, /\bsubir\b/, /\bplanilla\b/,
  /\bhoja de calculo\b/, /\bhoja de cálculo\b/, /\bxlsx?\b/,
];
const T5_MANUAL_PATTERNS: RegExp[] = [
  /\bescribir a mano\b/, /\bescribir\b/, /\bmanual\b/, /\ba mano\b/,
  /\btipear\b/, /\btipeo\b/, /\btipiar\b/, /\bteclado\b/, /\btecla\b/,
  /\bescrib\w*\b/,
];
const T5_VOZ_PATTERNS: RegExp[] = [
  /\bvoz\b/, /\bhablar\b/, /\bdictar\b/, /\bdict\w*\b/, /\bmicro(fono)?\b/,
];

const T5_FOTO_VALUES = new Set(["foto"]);
const T5_ARCHIVO_VALUES = new Set([
  "archivo", "subir archivo", "subir excel", "subir csv",
  "excel", "csv", "subir excel o csv", "excel o csv",
]);
const T5_MANUAL_VALUES = new Set([
  "escribir a mano", "manual", "a mano", "tipear", "teclado",
  "escribir", "cargar manual",
]);
const T5_VOZ_VALUES = new Set(["voz"]);

export type T5Choice = "foto" | "archivo" | "manual" | "voz";

export function detectT5Choice(text: string): T5Choice | null {
  const normalized = normalizeForMatching(text).trim();
  if (!normalized) return null;

  // 1. Chip-exact (lo que viaja cuando el dueño tapeó un chip del cliente).
  if (T5_FOTO_VALUES.has(normalized)) return "foto";
  if (T5_ARCHIVO_VALUES.has(normalized)) return "archivo";
  if (T5_MANUAL_VALUES.has(normalized)) return "manual";
  if (T5_VOZ_VALUES.has(normalized)) return "voz";

  // 2. Free-text — patterns. Archivo y foto antes de manual: "tengo un excel"
  //    o "saco foto al cuaderno" son señales más fuertes que la palabra
  //    "escribir" que aparece como sub-string de muchas otras frases.
  if (T5_FOTO_PATTERNS.some((re) => re.test(normalized))) return "foto";
  if (T5_ARCHIVO_PATTERNS.some((re) => re.test(normalized))) return "archivo";
  if (T5_VOZ_PATTERNS.some((re) => re.test(normalized))) return "voz";
  if (T5_MANUAL_PATTERNS.some((re) => re.test(normalized))) return "manual";

  return null;
}
