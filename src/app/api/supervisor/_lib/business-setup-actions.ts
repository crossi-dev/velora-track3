// Handler que ejecuta acciones `update_business_setup` emitidas por el Supervisor
// durante el onboarding conversacional. Cada turno captura UN dato del negocio y
// este handler lo persiste en la fila Business del dueño.
//
// Diseño:
// - Solo el dueño OAuth puede emitir estas acciones (RBAC en el caller).
// - Validación estricta de `field` y `value` por tipo — descarta acciones malformadas
//   sin tirar excepción (fail-soft, igual que rule/policy actions).
// - openingCash siempre setea openingCashConfigured=true: 0 es un monto válido y la
//   única forma de saber que el dueño contestó el turno 4 es este flag.
// - paymentMethods: se almacena como array de strings — los duplicados se descartan.
// - Errores se devuelven como string para que el caller los concatene; nunca tira.
//
// La invalidación del cache de supervisor-context se hace después de escribir para
// que el siguiente turno lea el estado actualizado.

import { reportWarning } from "@/lib/cloud-logger";
import { isValidPostalCode } from "@/lib/shipping-quote";
import type { SupervisorAction } from "./business-rule-actions";
import {
  asObject,
  isNonEmptyString,
  normalizePaymentMethods,
  coerceCash,
  persistSetupField,
} from "./business-setup-actions.helpers";
import { executeFiscalSetupField } from "./business-setup-actions.fiscal";
import { executeDeferFlagField, isDeferFlagField } from "./business-setup-actions.defer-flags";
import { executeByoaField, isByoaField } from "./business-setup-actions.byoa";

export type BusinessSetupField =
  | "businessName"
  | "businessType"
  | "paymentMethods"
  | "openingCash"
  | "mercadoPagoOnboardingDeferred"
  | "customersOnboardingSkipped"
  | "arcaOnboardingDeferred"
  | "andreaniOnboardingDeferred"
  | "postalCode"
  | "courierPreference"
  | "transferAlias"
  | "whatsappPhone"
  // Fiscal-setup mini-flow (post-onboarding, added C1 2026-05-18)
  | "cuit"
  | "ivaCondition"
  | "puntoVenta"
  // BYOA credentials (added 2026-05-25)
  | "arcaDelegationCuit"
  | "arcaDelegationPendingStep"
  | "andreaniApiToken"
  | "andreaniTokenPendingStep"
  // Onboarding redesign 2026-05-25
  | "skippedCatalog"
  | "firstSalePromptShown";

const VALID_FIELDS: ReadonlySet<BusinessSetupField> = new Set([
  "businessName",
  "businessType",
  "paymentMethods",
  "openingCash",
  "mercadoPagoOnboardingDeferred",
  "customersOnboardingSkipped",
  "arcaOnboardingDeferred",
  "andreaniOnboardingDeferred",
  "postalCode",
  "courierPreference",
  "transferAlias",
  "whatsappPhone",
  "cuit",
  "ivaCondition",
  "puntoVenta",
  "arcaDelegationCuit",
  "arcaDelegationPendingStep",
  "andreaniApiToken",
  "andreaniTokenPendingStep",
  "skippedCatalog",
  "firstSalePromptShown",
]);

const COURIER_ALLOWLIST: ReadonlySet<string> = new Set(["Andreani", "OCA", "Correo", "ninguno"]);

export interface BusinessSetupActionResult {
  /** Confirmación human-readable agregable al answer del supervisor. */
  confirmation: string | null;
  /** Mensaje de error (si la action era inválida). null si todo OK. */
  error: string | null;
  /** 1 si se persistió un cambio, 0 si no. */
  affected: number;
}

export function isBusinessSetupAction(action: SupervisorAction): boolean {
  return action.intent === "update_business_setup";
}

export async function executeBusinessSetupAction(
  action: SupervisorAction,
  businessId: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<BusinessSetupActionResult> {
  if (!isBusinessSetupAction(action)) {
    return { confirmation: null, error: "not a business_setup action", affected: 0 };
  }
  const data = asObject(action.data);
  if (!data) {
    return { confirmation: null, error: `${action.intent} sin data válida`, affected: 0 };
  }
  const field = data.field;
  if (!isNonEmptyString(field) || !VALID_FIELDS.has(field as BusinessSetupField)) {
    return {
      confirmation: null,
      error: "field inválido (esperado businessName | businessType | paymentMethods | openingCash | mercadoPagoOnboardingDeferred | postalCode | courierPreference | transferAlias | whatsappPhone | cuit | ivaCondition | puntoVenta | arcaDelegationCuit | arcaDelegationPendingStep | andreaniApiToken | andreaniTokenPendingStep)",
      affected: 0,
    };
  }

  try {
    if (field === "businessName") {
      if (!isNonEmptyString(data.value)) {
        return { confirmation: null, error: "value debe ser string no vacío para businessName", affected: 0 };
      }
      const outcome = await persistSetupField({
        businessId, actorUserId, idempotencySeed, field: "businessName",
        payload: { name: data.value.trim() }, data: { value: data.value.trim() },
      });
      return {
        confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "Nombre del negocio guardado."),
        error: null,
        affected: outcome === "persisted" ? 1 : 0,
      };
    }

    if (field === "businessType") {
      if (!isNonEmptyString(data.value)) {
        return { confirmation: null, error: "value debe ser string no vacío para businessType", affected: 0 };
      }
      const outcome = await persistSetupField({
        businessId, actorUserId, idempotencySeed, field: "businessType",
        payload: { type: data.value.trim() }, data: { value: data.value.trim() },
      });
      return {
        confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "Tipo de negocio guardado."),
        error: null,
        affected: outcome === "persisted" ? 1 : 0,
      };
    }

    if (field === "paymentMethods") {
      const methods = normalizePaymentMethods(data.value);
      if (!methods || methods.length === 0) {
        return { confirmation: null, error: "value debe ser array de strings con al menos un método", affected: 0 };
      }
      const outcome = await persistSetupField({
        businessId, actorUserId, idempotencySeed, field: "paymentMethods",
        payload: { paymentMethods: methods }, data: { value: methods },
      });
      return {
        confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "Métodos de pago guardados."),
        error: null,
        affected: outcome === "persisted" ? 1 : 0,
      };
    }

    if (field === "mercadoPagoOnboardingDeferred") {
      // Accept both true (defer) and false (un-defer — re-prompts T9 on next turn).
      if (data.value !== true && data.value !== false) {
        return { confirmation: null, error: "value debe ser true o false para mercadoPagoOnboardingDeferred", affected: 0 };
      }
      const deferred = data.value === true;
      const outcome = await persistSetupField({
        businessId, actorUserId, idempotencySeed, field: "mercadoPagoOnboardingDeferred",
        payload: { mercadoPagoOnboardingDeferred: deferred }, data: { value: deferred },
      });
      return {
        confirmation: outcome === "skipped" ? null : (
          action.summary ? `Listo, ${action.summary.toLowerCase()}.` :
          deferred ? "Conexión MP diferida." : "Conexión MP activada para continuar."
        ),
        error: null,
        affected: outcome === "persisted" ? 1 : 0,
      };
    }

    // T12/T13/T14 defer flags (handler in defer-flags sibling).
    if (isDeferFlagField(field)) {
      return executeDeferFlagField({ field, value: data.value, businessId, actorUserId, idempotencySeed, summary: action.summary });
    }

    // BYOA credential fields (handler in byoa sibling).
    if (isByoaField(field)) {
      return executeByoaField({ field, value: data.value, businessId, actorUserId, idempotencySeed, summary: action.summary });
    }

    if (field === "postalCode") {
      const cp = typeof data.value === "string" ? data.value.trim() : null;
      if (!isValidPostalCode(cp)) {
        return { confirmation: null, error: "postalCode debe ser 4-5 dígitos numéricos", affected: 0 };
      }
      const outcome = await persistSetupField({
        businessId, actorUserId, idempotencySeed, field: "postalCode",
        payload: { postalCode: cp }, data: { value: cp },
      });
      return {
        confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "Código postal guardado."),
        error: null,
        affected: outcome === "persisted" ? 1 : 0,
      };
    }

    if (field === "courierPreference") {
      const courier = typeof data.value === "string" ? data.value.trim() : null;
      if (!courier || !COURIER_ALLOWLIST.has(courier)) {
        return { confirmation: null, error: "courierPreference debe ser Andreani | OCA | Correo | ninguno", affected: 0 };
      }
      const outcome = await persistSetupField({
        businessId, actorUserId, idempotencySeed, field: "courierPreference",
        payload: { courierPreference: courier }, data: { value: courier },
      });
      return {
        confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "Preferencia de correo guardada."),
        error: null,
        affected: outcome === "persisted" ? 1 : 0,
      };
    }

    if (field === "transferAlias") {
      const alias = typeof data.value === "string" ? data.value.trim() : null;
      if (alias === null || alias.length === 0) {
        return { confirmation: null, error: "transferAlias debe ser un alias o CBU no vacío", affected: 0 };
      }
      const outcome = await persistSetupField({
        businessId, actorUserId, idempotencySeed, field: "transferAlias",
        payload: { alias }, data: { value: alias },
      });
      return {
        confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "Alias de transferencia guardado."),
        error: null,
        affected: outcome === "persisted" ? 1 : 0,
      };
    }

    if (field === "whatsappPhone") {
      // Empty string is a valid sentinel meaning "deferred" — persisted so the flag counts as set.
      if (typeof data.value !== "string") {
        return { confirmation: null, error: "whatsappPhone debe ser string (vacío para diferir)", affected: 0 };
      }
      const phone = data.value.trim();
      const outcome = await persistSetupField({
        businessId, actorUserId, idempotencySeed, field: "whatsappPhone",
        payload: { whatsappPhone: phone }, data: { value: phone },
      });
      return {
        confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "WhatsApp guardado."),
        error: null,
        affected: outcome === "persisted" ? 1 : 0,
      };
    }

    // ── Fiscal-setup fields (C1 2026-05-18) — delegated to .fiscal sibling ──
    if (field === "cuit" || field === "ivaCondition" || field === "puntoVenta") {
      return executeFiscalSetupField(field, data, action, businessId, actorUserId, idempotencySeed);
    }

    // openingCash
    const cash = coerceCash(data.value);
    if (cash === null) {
      return { confirmation: null, error: "value debe ser un monto numérico no negativo para openingCash", affected: 0 };
    }
    const outcome = await persistSetupField({
      businessId, actorUserId, idempotencySeed, field: "openingCash",
      payload: { openingCash: cash, openingCashConfigured: true }, data: { value: cash },
    });
    return {
      confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "Caja inicial guardada."),
      error: null,
      affected: outcome === "persisted" ? 1 : 0,
    };
  } catch (err) {
    reportWarning("[business-setup-actions] DB write failed", {
      scope: "business-setup-actions",
      field,
      businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      confirmation: null,
      error: err instanceof Error ? err.message : "Error desconocido al persistir el setup del negocio",
      affected: 0,
    };
  }
}

// Batch executor lives in the byoa sibling to keep this file under 300 LOC.
export { executeBusinessSetupActions } from "./business-setup-actions.byoa";
