// Final defense against past-tense action hallucinations when the model
// classifies an action turn as `intent: "answer"` (i.e. the handler never
// runs, so the deterministic templates in `intent-handlers/*` don't fire).
// Patterns are deliberately phrase-shaped — single past-tense verbs are too
// permissive (legitimate query answers like "Pagaste 3 cuotas" would trip
// them). We match verb + action-noun colocations that the model only emits
// when it thinks it just performed a write.

const PROHIBITED_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "registrada+noun", regex: /\bregistrad[ao]s?\b.{0,80}\b(vent|gasto|ingreso|movimiento|client|producto|proveedor|pago|compra|presupuesto)/i },
  { name: "noun+registrada", regex: /\b(vent|gasto|ingreso|movimiento|client|producto|proveedor|pago|compra|presupuesto)\w*\b.{0,80}\bregistrad[ao]s?\b/i },
  { name: "vendido", regex: /\bvendid[ao]s?\b/i },
  { name: "ya quedó", regex: /\bya\s+qued[oó]/i },
  { name: "ya está + write-verb", regex: /\bya\s+est[aá]\s.{0,40}(registrad|cargad|cread|guardad|agregad|actualizad|modificad|eliminad)/i },
  { name: "listo, + write-verb", regex: /\blisto[,\s]+.{0,60}\b(registr|cargu|cargad|cre[eé]|cread|guardad|elimin|actualic|actualizad|agreg|modific|edit)/i },
];

export interface HallucinationCheck {
  matched: boolean;
  patternName?: string;
}

export function detectActionHallucination(answer: string): HallucinationCheck {
  if (!answer) return { matched: false };
  for (const { name, regex } of PROHIBITED_PATTERNS) {
    if (regex.test(answer)) return { matched: true, patternName: name };
  }
  return { matched: false };
}

// Generic fallback shown when the model's free-text answer is suppressed.
// Friendly, non-blaming, prompts the employee to reformulate.
export const HALLUCINATION_FALLBACK_ANSWER =
  "Disculpá, no te entendí del todo. ¿Me lo podés decir de nuevo, con un poco más de detalle?";
