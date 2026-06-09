// Fiscal-setup field handlers for business-setup-actions.ts (C1 2026-05-18).
// Split here to keep business-setup-actions.ts under the 300-line server limit.
// Handles: cuit, ivaCondition, puntoVenta.

import type { SupervisorAction } from "./business-rule-actions";
import { persistSetupField } from "./business-setup-actions.helpers";
import type { BusinessSetupActionResult } from "./business-setup-actions";
import { IVA_CONDITION_ALLOWLIST } from "@/app/api/business-assistant/_lib/onboarding-fast-path.fiscal-setup";
import type { IvaCondition } from "@/app/api/business-assistant/_lib/onboarding-fast-path.fiscal-setup";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

export async function executeFiscalSetupField(
  field: "cuit" | "ivaCondition" | "puntoVenta",
  data: Record<string, unknown>,
  action: SupervisorAction,
  businessId: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<BusinessSetupActionResult> {
  if (field === "cuit") {
    const cuit = typeof data.value === "string" ? data.value.replace(/\D/g, "") : null;
    if (!cuit || cuit.length !== 11) {
      return { confirmation: null, error: "cuit debe ser 11 dígitos numéricos", affected: 0 };
    }
    const outcome = await persistSetupField({
      businessId, actorUserId, idempotencySeed, field: "cuit",
      payload: { cuit }, data: { value: cuit },
    });
    if (outcome === "persisted") {
      // Sync ArcaCredential.cuit if a row exists for this business. Runs
      // outside the idempotency transaction — best-effort, non-blocking.
      prisma.arcaCredential.updateMany({
        where: { businessId },
        data: { cuit },
      }).catch((err: unknown) => {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "ARCA_CUIT_SYNC_FAILED",
          a2a_transfer: false,
          message: "Failed to sync ArcaCredential.cuit after Business CUIT update",
          businessId,
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      });
    }
    return {
      confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "CUIT guardado."),
      error: null,
      affected: outcome === "persisted" ? 1 : 0,
    };
  }

  if (field === "ivaCondition") {
    const iva = typeof data.value === "string" ? data.value.trim() : null;
    // Cast: IVA_CONDITION_ALLOWLIST.has expects IvaCondition; the runtime check IS the guard.
    if (!iva || !IVA_CONDITION_ALLOWLIST.has(iva as IvaCondition)) {
      return { confirmation: null, error: "ivaCondition debe ser Monotributista | Responsable Inscripto | Exento", affected: 0 };
    }
    const outcome = await persistSetupField({
      businessId, actorUserId, idempotencySeed, field: "ivaCondition",
      payload: { ivaCondition: iva }, data: { value: iva },
    });
    return {
      confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "Condición IVA guardada."),
      error: null,
      affected: outcome === "persisted" ? 1 : 0,
    };
  }

  // puntoVenta — "0" is the sentinel for "deferred"; valid numeric strings 1-9999 otherwise.
  const pv = typeof data.value === "string" ? data.value.trim() : null;
  if (!pv || !/^\d{1,4}$/.test(pv)) {
    return { confirmation: null, error: "puntoVenta debe ser un número de 1-4 dígitos (o 0 para diferir)", affected: 0 };
  }
  const outcome = await persistSetupField({
    businessId, actorUserId, idempotencySeed, field: "puntoVenta",
    payload: { puntoVenta: pv }, data: { value: pv },
  });
  return {
    confirmation: outcome === "skipped" ? null : (action.summary ? `Listo, ${action.summary.toLowerCase()}.` : "Punto de venta guardado."),
    error: null,
    affected: outcome === "persisted" ? 1 : 0,
  };
}
