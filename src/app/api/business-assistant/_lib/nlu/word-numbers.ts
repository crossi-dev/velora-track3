// Spanish word-number → digit normalization for the NLU layer.
//
// Applied conservatively before deterministic intent detection so the
// stock-load fast-path pre-check (/\d/.test) does not bail on phrases like
// "seis unidades". Only replaces a word-number when it is followed by an
// explicit quantity-unit word or sentence-ending punctuation — avoids false
// positives like product names that contain a number word.
//
// Intentionally excludes un/uno/una: in practice these are almost always
// articles ("un paquete de cerveza") rather than the cardinal number 1.
// A real quantity of 1 either comes as a digit or via context defaults.
//
// Also handles the idioms "media docena" → 6 and standalone "docena" → 12.
//
// Delegates to the canonical parseSpanishNumber() from @/lib/word-to-number
// (audit ref: velora/audit/parsing-tanda-1/number-date-parsing).

import { parseSpanishNumber } from "@/lib/word-to-number";

/** Units that confirm a preceding word-number is a cardinal quantity. */
const QUANTITY_UNIT_LOOKAHEAD =
  "unidades?|u\\.?|cajas?|bolsas?|botellas?|latas?|kg|kilos?|litros?|lt?|paquetes?|docenas?|piezas?";

const STOCK_WORD_NUM_RE = new RegExp(
  // un/uno/una intentionally excluded — see module comment above.
  // Accented alternates (dieciséis, veintidós, veintitrés) included so the
  // regex matches raw user text that hasn't been accent-stripped yet.
  "\\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|" +
  "once|doce|trece|catorce|quince|diecis(?:e|é)is|diecisiete|dieciocho|diecinueve|" +
  "veinte|veintiuno|veintid(?:o|ó)s|veintitr(?:e|é)s|veinticuatro|veinticinco|" +
  "treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|" +
  "cien|ciento|doscientos|doscientas|trescientos|trescientas|" +
  "cuatrocientos|cuatrocientas|quinientos|quinientas|mil)" +
  `(?=\\s+(?:${QUANTITY_UNIT_LOOKAHEAD})|[.,;!?])`,
  "gi",
);

export function normalizeStockWordNumbers(text: string): string {
  // Multi-word idioms first (order matters: before the single-word pass).
  let result = text.replace(/\bmedia\s+docena\b/gi, "6");
  result = result.replace(/\bdocena\b/gi, "12");
  return result.replace(STOCK_WORD_NUM_RE, (match) => {
    const val = parseSpanishNumber(match);
    return val !== null ? String(val) : match;
  });
}
