// onboarding-polish.ts — Thin shim over reply-polish.ts for onboarding acks (T1-T5).
//
// Toma el texto determinístico del fast path y delega el polish a reply-polish.ts,
// que centraliza la llamada a Flash para todos los outputs del chat.
// Es stateless: no lee ni escribe DB, no toca chips ni actions.
//
// Activación: ONBOARDING_POLISH_ENABLED=true (default off).
// Si Flash falla o supera el timeout de 2s (controlado en reply-polish.ts),
// devuelve el fallbackText intacto para no bloquear el onboarding.

import { polishReply } from "./reply-polish";

// ── Tipos públicos ────────────────────────────────────────────────────────

export interface PolishOnboardingAckParams {
  /** Número de turno que se acaba de resolver. Turn 4 (opening cash) was removed
   *  in Fase B and is never produced by the fast path. */
  turno: 1 | 2 | 3 | 5;
  /** Nombre del negocio, si ya fue capturado (puede ser undefined en T1). */
  businessName?: string;
  /** Tipo de negocio, si ya fue capturado. */
  businessType?: string;
  /** El dato que se acaba de confirmar en este turno. */
  datoCapturado: string;
  /** Texto que se devuelve si Flash falla o se pasa del timeout. */
  fallbackText: string;
}

// ── Context metadata — passed to reply-polish as structured hints ─────────

// Descripciones de cada turno para darle contexto al modelo.
const TURN_LABELS: Record<number, string> = {
  1: "nombre del negocio",
  2: "tipo de negocio / rubro",
  3: "métodos de pago aceptados",
  // NOTE: turn 4 (opening cash) removed in Fase B — polish only fires turns 1-5
  // but matchedTurn=4 is no longer produced by the fast path.
  5: "método para cargar el primer producto",
};

// Turn 4 (opening cash) was removed in Fase B — entry removed to avoid dead code.
// Turn 2 (business type) was removed — T1 name goes directly to T3 payment methods.
const NEXT_STEP_HINTS: Record<number, string> = {
  1: "a continuación se le pregunta los métodos de pago (T2/tipo de negocio fue eliminado del flujo)",
  3: "a continuación se le pregunta el alias/CBU (si eligió Transferencia) o el código postal",
  5: "el onboarding está prácticamente terminado",
};

// ── API pública ──────────────────────────────────────────────────────────

/**
 * Devuelve el texto del ack "pulido" por Flash, delegando a reply-polish.ts.
 *
 * Si la env var ONBOARDING_POLISH_ENABLED != "true", devuelve fallbackText
 * inmediatamente (zero overhead). Si Flash falla o supera 2s, ídem.
 *
 * Nunca lanza: el caller puede reemplazar `fastPath.answer` con este resultado
 * de forma segura. Firma preservada — callers existentes no cambian.
 */
export async function polishOnboardingAck(
  params: PolishOnboardingAckParams,
): Promise<string> {
  if (process.env.ONBOARDING_POLISH_ENABLED !== "true") {
    return params.fallbackText;
  }

  const context: Record<string, string> = {
    turno: String(params.turno),
    turnoLabel: TURN_LABELS[params.turno] ?? "desconocido",
    datoCapturado: params.datoCapturado,
    siguientePaso: NEXT_STEP_HINTS[params.turno] ?? "",
  };
  if (params.businessName) context.businessName = params.businessName;
  if (params.businessType) context.businessType = params.businessType;

  return polishReply({
    fallbackText: params.fallbackText,
    kind: "onboarding_ack",
    intentKind: `onboarding_t${params.turno}`,
    context,
  });
}
