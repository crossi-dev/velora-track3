// Release-on-action-intent decision logic for ownerOnboardingAgentStage.
//
// Extracted from owner-handler.stages-onboarding-agent.ts (Fase 6 JD round 1)
// to keep the parent stage under the 300-LOC contract.
//
// Per ADK Coordinator pattern, specialist agents claim turns only within their
// domain. Onboarding's domain is "guide setup"; once the user expresses a
// clear action intent, we exit the funnel and let the action proceed.
// (Mirrors Stripe Incremental Onboarding: accept what the user offers, prompt
// for currently_due fields via UI buoy / banner, not by hijacking the chat.)
//
// 2026-05-30 OA Phase 4 cleanup: Flash classifier removed from pipeline.
// The Flash-based `shouldReleaseOnboardingTurn(classifiedIntent, pendingTurn)`
// is replaced by regex-based detection over raw user text. Same semantic:
// if the text looks like a mutation command, release the turn.
//
// ─── Regex design ────────────────────────────────────────────────────────────
//
// Uses lookbehind/lookahead `(?<![a-zA-Z])...(?![a-zA-Z])` instead of `\b`
// because `\b` does not handle accented characters (á, é, í) correctly in
// JavaScript — `\b` treats accented chars as non-word chars, so `\bcargá\b`
// fails to match even when surrounded by spaces.
//
// Covered action verbs (Rioplatense forms):
//   cargar/cargá, crear/creá, agregar/agregá/añadir/añadí,
//   registrar/registrá, vender/vendé, ajustar/ajustá,
//   modificar/modificá, editar/editá, actualizar/actualizá,
//   subir/subí, borrar/borrá, eliminar/eliminá, descontar/descontá,
//   nuevo/nueva, proveedor, movimiento, caja, cliente
//
// Intentionally conservative (wide): false positives (releases turn when
// it's actually a query) are harmless — the action goes to OA/Supervisor and
// is resolved normally. False negatives (keeps an action turn in onboarding)
// would be the real bug. So err on the side of releasing.
//
// T5 override: T5 is the catalog-setup turn. Product-creation verbs at T5
// MUST NOT release — the onboarding state machine needs to record the product
// via the T5 fast-path. But sale/undo/cash verbs at T5 still release (those
// cannot advance the T5 state machine).
//
// Source (verified HTTP 200 2026-05-28):
//   https://adk.dev/workflows/collaboration/

// ─── ACTION_VERB_RE ──────────────────────────────────────────────────────────

const ACTION_VERB_RE = /(?<![a-zA-Z])(?:carg(?:á|ar?)|cre(?:á|ar?)|agreg(?:á|ar?)|añad(?:í|ir?)|registr(?:á|ar?)|vend(?:é|er?|i(?:ste|mos)?)|ajust(?:á|ar?)|modific(?:á|ar?)|edit(?:á|ar?)|actualiz(?:á|ar?)|sub(?:í|ir?)|borr(?:á|ar?)|elimin(?:á|ar?)|descont(?:á|ar?)|nuevo|nueva|proveedor|movimiento|caja|cliente)(?![a-zA-Z])/i;

// Product-creation-specific verbs for T5 suppression.
// Only these should stay with onboarding at T5; sale/undo verbs still release.
const PRODUCT_CREATION_RE = /(?<![a-zA-Z])(?:carg(?:á|ar?)|cre(?:á|ar?)|agreg(?:á|ar?)|añad(?:í|ir?)|actualiz(?:á|ar?))(?![a-zA-Z])/i;

// ─── Public exports ──────────────────────────────────────────────────────────

/**
 * Returns true when raw user text contains an action/mutation verb.
 * Exported for unit tests — not part of the public module API.
 */
export function mightBeActionIntent(text: string): boolean {
  if (!text || !text.trim()) return false;
  return ACTION_VERB_RE.test(text);
}

/**
 * Decides whether OnboardingAgent should release the turn to downstream stages.
 *
 * Returns true when the user's raw text looks like a mutation/action command
 * AND the current onboarding turn does not own that domain.
 *
 * Per-turn overrides:
 *   T1 (business name not set): name MUST be collected before anything else
 *     proceeds — action verbs do NOT release at T1. Design §7.2.
 *   T5 (catalog setup) owns product-creation verbs — "alfajor 800" / "cargá
 *     producto X" must advance the T5 state machine, not bypass it via OA.
 *     However, sale/undo/cash verbs at T5 still release (they can't advance T5).
 *
 * Exported for unit testing — see tests/unit/owner-pipeline-onboarding-release.test.cjs.
 */
export function shouldReleaseOnboardingTurn(
  text: string,
  pendingTurn: number,
): boolean {
  if (!mightBeActionIntent(text)) return false;
  // T1: name gate — must collect business name before releasing any action intent.
  // Without a name the business is not operable; releasing at T1 creates orphan
  // data with no owner identity. Design §7.2.
  if (pendingTurn === 1) return false;
  // T5 suppresses product-creation verbs so the onboarding state machine advances.
  // Sale/undo verbs at T5 still release (they can't advance the T5 catalog flow).
  if (pendingTurn === 5 && PRODUCT_CREATION_RE.test(text)) return false;
  return true;
}
