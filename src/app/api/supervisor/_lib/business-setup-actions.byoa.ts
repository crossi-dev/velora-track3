// BYOA (Bring Your Own Account) field handlers for update_business_setup.
// Handles arcaDelegationCuit, arcaDelegationPendingStep, andreaniApiToken,
// andreaniTokenPendingStep — fields set by the T13/T14 BYOA onboarding flow.
//
// Split from business-setup-actions.ts to keep that file under 300 LOC.

import { persistSetupField } from "./business-setup-actions.helpers";
import type { BusinessSetupActionResult } from "./business-setup-actions";
import type { SupervisorAction } from "./business-rule-actions";

export type ByoaField =
  | "arcaDelegationCuit"
  | "arcaDelegationPendingStep"
  | "andreaniApiToken"
  | "andreaniTokenPendingStep";

const BYOA_FIELDS: ReadonlySet<ByoaField> = new Set([
  "arcaDelegationCuit",
  "arcaDelegationPendingStep",
  "andreaniApiToken",
  "andreaniTokenPendingStep",
]);

export function isByoaField(field: string): field is ByoaField {
  return BYOA_FIELDS.has(field as ByoaField);
}

/**
 * Persists one BYOA credential field on the Business row.
 *
 * arcaDelegationCuit: string | null — canonical "XX-XXXXXXXX-X" or null to clear.
 * arcaDelegationPendingStep: "awaiting_cuit" | null
 * andreaniApiToken: AES-256-GCM ciphertext string (from credential-cipher.ts) or null
 * andreaniTokenPendingStep: "awaiting_token" | null
 */
export async function executeByoaField(args: {
  field: ByoaField;
  value: unknown;
  businessId: string;
  actorUserId: string;
  idempotencySeed: string;
  summary?: string;
}): Promise<BusinessSetupActionResult> {
  const { field, value, businessId, actorUserId, idempotencySeed, summary } = args;

  // All BYOA fields accept a non-empty string or null (to clear the field).
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    return {
      confirmation: null,
      error: `${field}: value debe ser string no vacío o null`,
      affected: 0,
    };
  }

  const normalized = value === null ? null : (value as string).trim();

  const outcome = await persistSetupField({
    businessId,
    actorUserId,
    idempotencySeed,
    field,
    payload: { [field]: normalized },
    data: { value: normalized },
  });

  const defaultMsg: Record<ByoaField, string> = {
    arcaDelegationCuit:       normalized ? `CUIT ${normalized} registrado para ARCA.` : "CUIT ARCA limpiado.",
    arcaDelegationPendingStep: normalized ? "ARCA: esperando CUIT." : "ARCA: paso pendiente limpiado.",
    andreaniApiToken:         normalized ? "Token de Andreani encriptado y guardado." : "Token de Andreani limpiado.",
    andreaniTokenPendingStep: normalized ? "Andreani: esperando token." : "Andreani: paso pendiente limpiado.",
  };

  return {
    confirmation: outcome === "skipped" ? null : (summary ? `Listo, ${summary.toLowerCase()}.` : defaultMsg[field]),
    error: null,
    affected: outcome === "persisted" ? 1 : 0,
  };
}

// Batch executor for update_business_setup actions.
// Moved here from business-setup-actions.ts to keep that file under 300 LOC.
// Imported from the main file via re-export so callers see no change.
export async function executeBusinessSetupActions(
  actions: ReadonlyArray<SupervisorAction>,
  businessId: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<{
  confirmations: string[];
  errors: string[];
  totalAffected: number;
  setupActionCount: number;
}> {
  // Lazy import to avoid circular dependency (byoa imports from business-setup-actions).
  const { executeBusinessSetupAction, isBusinessSetupAction } =
    await import("./business-setup-actions");
  const confirmations: string[] = [];
  const errors: string[] = [];
  let totalAffected = 0;
  let setupActionCount = 0;
  for (const action of actions) {
    if (!isBusinessSetupAction(action)) continue;
    const result = await executeBusinessSetupAction(action, businessId, actorUserId, `${idempotencySeed}|${setupActionCount}`);
    setupActionCount += 1;
    if (result.confirmation) confirmations.push(result.confirmation);
    if (result.error) errors.push(result.error);
    totalAffected += result.affected;
  }
  return { confirmations, errors, totalAffected, setupActionCount };
}
