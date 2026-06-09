// Defer-flag handlers for onboarding turns T12 (clientes), T13 (ARCA), T14 (Andreani).
// Split from business-setup-actions.ts to keep that file under the 300 LOC cap.
//
// Each flag is a Business boolean. Setting it true marks the corresponding
// onboarding turn as "done" so detectPendingTurn stops re-prompting for it.
// Setting it false re-opens the turn (rare; supports explicit revisit).
//
// Special case: firstSalePromptShown=true also stamps firstSalePromptShownAt
// so the first-sale-nudge cron can calculate the 24h eligibility window.

import { persistSetupField } from "./business-setup-actions.helpers";
import type { BusinessSetupActionResult } from "./business-setup-actions";

export type DeferFlagField =
  | "customersOnboardingSkipped"
  | "arcaOnboardingDeferred"
  | "andreaniOnboardingDeferred"
  | "skippedCatalog"
  | "firstSalePromptShown";

const COPY: Record<DeferFlagField, { ok: string; undo: string }> = {
  customersOnboardingSkipped: { ok: "Carga de clientes diferida.", undo: "Carga de clientes reactivada." },
  arcaOnboardingDeferred:     { ok: "Conexión ARCA diferida.",     undo: "Conexión ARCA reactivada." },
  andreaniOnboardingDeferred: { ok: "Conexión Andreani diferida.", undo: "Conexión Andreani reactivada." },
  skippedCatalog:             { ok: "Catálogo diferido.",          undo: "Catálogo reactivado." },
  firstSalePromptShown:       { ok: "Primer venta prompt marcado.",  undo: "Primer venta prompt reseteado." },
};

export function isDeferFlagField(field: string): field is DeferFlagField {
  return field === "customersOnboardingSkipped"
    || field === "arcaOnboardingDeferred"
    || field === "andreaniOnboardingDeferred"
    || field === "skippedCatalog"
    || field === "firstSalePromptShown";
}

export async function executeDeferFlagField(args: {
  field: DeferFlagField;
  value: unknown;
  businessId: string;
  actorUserId: string;
  idempotencySeed: string;
  summary?: string;
}): Promise<BusinessSetupActionResult> {
  const { field, value, businessId, actorUserId, idempotencySeed, summary } = args;
  if (value !== true && value !== false) {
    return { confirmation: null, error: `value debe ser true o false para ${field}`, affected: 0 };
  }
  const deferred = value === true;
  // When firstSalePromptShown is set to true, also stamp the timestamp so
  // the first-sale-nudge cron can calculate the 24h eligibility window.
  const extraPayload: Record<string, unknown> =
    field === "firstSalePromptShown" && deferred
      ? { firstSalePromptShownAt: new Date() }
      : {};
  const outcome = await persistSetupField({
    businessId, actorUserId, idempotencySeed, field,
    payload: { [field]: deferred, ...extraPayload }, data: { value: deferred },
  });
  return {
    confirmation: outcome === "skipped" ? null : (
      summary ? `Listo, ${summary.toLowerCase()}.` :
      deferred ? COPY[field].ok : COPY[field].undo
    ),
    error: null,
    affected: outcome === "persisted" ? 1 : 0,
  };
}
