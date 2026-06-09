// Deterministic hint pre-check — extracted from detect.ts.
// Provides a lightweight regex gate that skips the full dispatcher when
// the text contains no deterministic keyword. Fix for the "empty answer"
// bug class (commit e35fe6c6, 2026-05-10).

import { normalizeForMatching } from "../shared";

// Pre-check liviano: skipea el dispatcher entero cuando el texto no contiene
// ningún keyword determinístico. Evaluado contra texto YA NORMALIZADO
// (lowercased + accent-stripped) — stems anchos (`vend\w*`, `carg\w*`) toleran
// voseo AR.
// DETERMINISTIC_HINT_RE — lightweight gate for the owner pipeline.
// Stems are wide on purpose: `vend\w*` covers vendí/vendé/vendo/vendele/vendemos.
// Implicit sale slang patterns added 2026-05-15:
//   - "N product pa/para customer" (e.g. "tres cocas pa Lucía")
//   - "cobré/cobr N product" without explicit pa/para (e.g. "cobré dos alfajores")
// These patterns use a lookahead rather than simple stems so they don't widen
// the gate beyond sale-shaped utterances.
// Chip-tap machine tokens are prefixed/exact strings that contain underscores,
// so \blink\b never fires on "enviar_link_pago". Add them as explicit anchored
// alternates so the pre-check passes and dispatchDeterministicIntent is reached.
// Fix: BUG #37 — chip tap 504 timeout (ownerDeterministicDispatchStage was
// returning null early, letting the request fall to the supervisor LLM).
export const DETERMINISTIC_HINT_RE = /\b(borr|elimina|desha|cancel|devolv|devuelv|vend\w*|cobr\w*|pag\w*|qr|alias|cbu|transferencia|venta|factura|factur\w*|nuev[oa] cliente|agreg\w*|carg\w*|compr\w*|cambi\w*|registr\w*|crea|crear|crearme|modific\w*|actualiz\w*|edit\w*|renombr\w*|precio|valor|cuesta|vale|esta|stock|inventario|cuanta|cuantas|cuanto|gasto|ingreso|movimiento|caja|saque|saco|saca|sacar|sacame|retir\w*|meti|meter|metele|pone|poner|ponele|dej\w*|deposit\w*|proveedor|presupuesto|cotiza\w*|orden de compra|pedile|pedir|producto|articulo|ajusta|corregir|subi todo|aument|telefono|celular|whatsapp|llegar\w*|entrar\w*|recibi\w*|andreani|oca|modo|correo|arca|afip|envio|enviar|etiqueta|tracking|flete|link|conecta\w*|reconect\w*|vincul\w*)\b|(?:^|\s)(?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+\w+\s+pa(?:ra)?\s+\w|^enviar_link_pago\||^cancelar_link_pago$/i;

export function mightBeDeterministicIntent(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  // Normalize first so accented voseo verbs (`cargá`, `vendé`, `cambiá`,
  // `agregá`, `saqué`, `metí`) match the same stems as their unaccented
  // form. Without this, `\bvend\b` fails on `vendé` because `é` is a word
  // char that crosses the right boundary.
  const normalized = normalizeForMatching(text);
  return DETERMINISTIC_HINT_RE.test(normalized);
}
