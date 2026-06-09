// Bridge entre el handler cobro_qr y la API real de Mercado Pago.
//
// Aislado del handler principal para mantener cobro-qr-handler.ts bajo el
// hard limit de 300 LOC. La función intenta crear un QR real; si algo falla
// (MP API 5xx, timeout, shape inválido), devuelve null y el caller cae al
// placeholder. NUNCA lanza.
//
// Feature flag: MP_REAL_QR_ENABLED se lee runtime (no module-load) para que
// toggleos en Cloud Run env no requieran reboot.
//
// WS1-B — routing preferido (per-business):
//   resolveQrRouting resuelve primero vía getMpRoutingForBusiness (DB). Si el
//   negocio tiene una MpConnection válida con externalPosId configurado, el
//   QR se crea bajo su propia cuenta MP.
//
//   Fallback env: SÓLO cuando el negocio no tiene MpConnection
//   (MP_TOKEN_NOT_CONNECTED). Todos los demás sentinels — incluyendo null
//   (DB/infra error) — son hard-stop (sin env fallback). Un error de DB
//   NUNCA debe rutear silenciosamente al token central.
//
// MP_POS_NOT_CONFIGURED (lazy provisioning):
//   Si el negocio está conectado a MP pero no tiene externalPosId, el resolver
//   dispara provisioning en background y devuelve MP_POS_NOT_CONFIGURED.
//   El handler muestra "Estamos configurando tu QR, probá de nuevo en un
//   momento." El próximo intento encontrará el POS ya creado en DB.

import QRCode from "qrcode";
import { cloudLog } from "@/lib/cloud-logger";
import { getMpRouting } from "@/app/api/integrations/mp/_lib/mp-routing";
import { ensureMpStorePosProvisioned } from "@/app/api/integrations/mp/_lib/mp-pos-provisioning";
import { createMpDynamicQr, validatePosOnStartup } from "@/app/api/integrations/mp/_lib/mp-qr";
import {
  getMpRoutingForBusiness,
} from "@/app/api/agents/payments/jsonrpc/_lib/mp-qr-routing";
import {
  MP_TOKEN_NOT_CONNECTED,
  MP_TOKEN_EXPIRED,
  MP_TOKEN_DECRYPT_ERROR,
  MP_POS_NOT_CONFIGURED,
} from "@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers";

export interface RealQrAttempt {
  qrData: string;          // string raw que devolvió MP (URL del payment)
  qrSvgDataUrl: string;    // data:image/svg+xml,... para <img src>
  inStoreOrderId: string | null;
}

export interface AttemptRealQrInput {
  businessId: string;
  paymentIntentId: string;
  monto: number;
  expiresAt: Date;
}

// Returned when we know WHY the real QR can't be created so the caller can
// surface a user-facing Spanish error instead of the generic sandbox notice.
export interface RealQrBlocked {
  reason: "mp_not_connected" | "mp_token_expired" | "mp_token_error" | "mp_pos_not_configured" | "mp_db_error";
  userMessage: string;
}

function isFlagEnabled(): boolean {
  return (process.env.MP_REAL_QR_ENABLED ?? "").trim().toLowerCase() === "true";
}

// Resolves QR routing — DB-first (per-business), env fallback ONLY when the
// business has no MpConnection row (MP_TOKEN_NOT_CONNECTED).
//
// M1 FIX: null (DB/infra error) is a hard-stop — NEVER falls back to the
// central env account. Silently routing a charge to the wrong MP account
// on a DB error is a money-path correctness bug. Only MP_TOKEN_NOT_CONNECTED
// (deliberate absence: business never connected MP) may use the env fallback.
async function resolveQrRouting(businessId: string): Promise<
  | { ok: true; routing: { accessToken: string; mpUserId: string; externalPosId: string }; source: "db" | "env" }
  | { ok: false; blocked: RealQrBlocked }
  | { ok: false; blocked: null } // soft failure — env fallback already tried
> {
  const dbResult = await getMpRoutingForBusiness(businessId);

  if (dbResult !== null && dbResult !== MP_TOKEN_NOT_CONNECTED &&
      dbResult !== MP_TOKEN_EXPIRED && dbResult !== MP_TOKEN_DECRYPT_ERROR &&
      dbResult !== MP_POS_NOT_CONFIGURED) {
    // Happy path: full routing triple from DB.
    return { ok: true, routing: dbResult, source: "db" };
  }

  if (dbResult === MP_TOKEN_EXPIRED) {
    return {
      ok: false,
      blocked: {
        reason: "mp_token_expired",
        userMessage:
          "Tu conexión con Mercado Pago venció. Reconectá tu cuenta en Ajustes para cobrar con QR.",
      },
    };
  }
  if (dbResult === MP_TOKEN_DECRYPT_ERROR) {
    return {
      ok: false,
      blocked: {
        reason: "mp_token_error",
        userMessage:
          "Hubo un error con las credenciales de Mercado Pago. Reconectá tu cuenta en Ajustes.",
      },
    };
  }
  if (dbResult === MP_POS_NOT_CONFIGURED) {
    // H1 FIX: honest message — auto-provisioning is running in background;
    // do NOT tell the owner to configure a non-existent Settings field.
    return {
      ok: false,
      blocked: {
        reason: "mp_pos_not_configured",
        userMessage:
          "Estamos configurando tu QR de Mercado Pago, probá de nuevo en un momento.",
      },
    };
  }

  // M1 FIX: null = unexpected DB/infra error — hard-stop, NEVER fall back to
  // the central env account. Return an explicit blocked reason so the owner
  // sees an error rather than a charge silently going to the wrong account.
  if (dbResult === null) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_QR_ROUTING_DB_ERROR",
      a2a_transfer: false,
      message: "getMpRoutingForBusiness returned null (DB/infra error) — hard-stop, no env fallback",
      businessId,
    });
    return {
      ok: false,
      blocked: {
        reason: "mp_db_error",
        userMessage:
          "Hubo un error interno procesando el cobro. Probá de nuevo en un momento.",
      },
    };
  }

  // dbResult is MP_TOKEN_NOT_CONNECTED: business never connected their MP account.
  // Env fallback is intentional here — single-seller / demo compatibility.
  const envRouting = await getMpRouting(businessId);
  if (envRouting) {
    return { ok: true, routing: envRouting, source: "env" };
  }

  // Neither DB nor env has routing — soft failure, no explicit error.
  return { ok: false, blocked: null };
}

// Used by cobro-qr-handler.ts to surface the precise blocked reason vs
// the generic sandbox notice.
export async function attemptRealQrWithReason(
  input: AttemptRealQrInput,
): Promise<{ result: RealQrAttempt | null; blocked: RealQrBlocked | null }> {
  if (!isFlagEnabled()) return { result: null, blocked: null };

  const resolved = await resolveQrRouting(input.businessId);
  if (!resolved.ok) {
    if (resolved.blocked) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MP_QR_ROUTING_BLOCKED",
        a2a_transfer: false,
        message: `QR real bloqueado: ${resolved.blocked.reason}`,
        businessId: input.businessId,
        data: { reason: resolved.blocked.reason },
      });
      return { result: null, blocked: resolved.blocked };
    }
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_QR_NO_ROUTING",
      a2a_transfer: false,
      message: "MP_REAL_QR_ENABLED=true pero no hay routing — caigo a fake",
      businessId: input.businessId,
    });
    return { result: null, blocked: null };
  }

  const result = await buildQr(resolved.routing, input);
  return { result, blocked: null };
}

async function buildQr(
  routing: { accessToken: string; mpUserId: string; externalPosId: string },
  input: AttemptRealQrInput,
): Promise<RealQrAttempt | null> {
  // H2 FIX: validatePosOnStartup returning missingPos:true means the POS
  // confirmed absent from MP (the externalPosId stored in DB is stale or
  // the POS was deleted). Re-provision idempotently so the next attempt
  // succeeds, and return null to surface the "probá de nuevo" message.
  const posCheck = await validatePosOnStartup({
    accessToken: routing.accessToken,
    mpUserId: routing.mpUserId,
    externalPosId: routing.externalPosId,
  });
  if (posCheck.missingPos) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_QR_POS_MISSING_REPROVISIONING",
      a2a_transfer: false,
      message: "POS absent from MP — triggering re-provisioning for next attempt",
      businessId: input.businessId,
      data: { externalPosId: routing.externalPosId },
    });
    // Clear the stale externalPosId from DB so getMpRoutingForBusiness sees
    // it as null and triggers lazy provisioning on the next QR attempt.
    // Fire-and-forget — do not await; current QR attempt returns null.
    void (async () => {
      try {
        const { prisma } = await import("@/lib/prisma");
        await prisma.mpConnection.update({
          where: { businessId: input.businessId },
          data: { externalPosId: null },
        });
      } catch (err) {
        // The prisma.mpConnection.update failure is NOT logged by
        // ensureMpStorePosProvisioned — log it here so the DB failure
        // is visible in Cloud Logging and doesn't silently swallow the error.
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "MP_QR_POS_CLEAR_FAILED",
          a2a_transfer: false,
          message: "Failed to clear stale externalPosId from DB during POS re-provisioning",
          businessId: input.businessId,
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }
      // Kick off re-provisioning so it's ready for the next attempt.
      void ensureMpStorePosProvisioned({
        businessId: input.businessId,
        accessToken: routing.accessToken,
        mpUserId: routing.mpUserId,
      });
    })();
    return null;
  }

  const created = await createMpDynamicQr({
    accessToken: routing.accessToken,
    mpUserId: routing.mpUserId,
    externalPosId: routing.externalPosId,
    externalReference: `${input.businessId}:${input.paymentIntentId}`,
    businessId: input.businessId,
    monto: input.monto,
    description: `Venta ${input.paymentIntentId}`,
    expiresAt: input.expiresAt,
  });
  if (!created) return null;

  try {
    const svg = await QRCode.toString(created.qrData, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 180,
    });
    const qrSvgDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    return {
      qrData: created.qrData,
      qrSvgDataUrl,
      inStoreOrderId: created.inStoreOrderId,
    };
  } catch (error) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_QR_SVG_RENDER_FAILED",
      a2a_transfer: false,
      message: "QR SVG render falló post-MP",
      businessId: input.businessId,
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}
