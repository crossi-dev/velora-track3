// credential-update-handler.ts — Executors for post-onboarding credential
// update intents detected by nlu/credential-update-intent.ts.
//
// Three intents:
//   alias_update       → validate + persist via executeBusinessSetupActions + confirmation chip
//   courier_settings   → guide to Settings panel (NO raw-secret capture)
//   mp_oauth_reconnect → pre-flight MP connection state, then emit open_mp_oauth clientAction
//
// RBAC: all three are owner-only. Employee attempts receive a warm reject.
// Audit: all writes go through the supervisor contract guards
//        (beginIdempotentMutation + recordCriticalWriteEvent) via persistSetupField.

import { NextResponse } from "next/server";
import { cloudLog, logUnauthorizedAccess } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { executeBusinessSetupActions } from "@/app/api/supervisor/_lib/business-setup-actions";
import type { PreModelIntentParams } from "../router-params";
import type {
  AliasUpdateIntent,
  CourierSettingsIntent,
  CourierProvider,
  MpOAuthReconnectIntent,
  ServiceConnectIntent,
  GenericService,
} from "../nlu/credential-update-intent";

// ── Helpers ───────────────────────────────────────────────────────────────────

const COURIER_LABELS: Record<CourierProvider, string> = {
  andreani: "Andreani",
  oca: "OCA",
  correo: "Correo Argentino",
};

const COURIER_PANEL: Record<CourierProvider, string> = {
  andreani: "logistica.andreani",
  oca: "logistica.oca",
  correo: "logistica.correo",
};

const COURIER_HELP: Record<CourierProvider, string> = {
  andreani: "clientId, secret y número de contrato del portal Andreani Empresas",
  oca: "usuario y contraseña de tu cuenta OCA Empresas",
  correo: "usuario y contraseña de tu cuenta Correo Argentino Empresas",
};

function ownerOnlyReject(action: string, params: PreModelIntentParams): NextResponse {
  logUnauthorizedAccess({
    attemptedAction: action,
    actorRole: params.actorRole,
    endpoint: "/api/business-assistant [credential-update-handler]",
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId ?? undefined,
  });
  return NextResponse.json({
    answer: "Esta acción es solo para el dueño. Si necesitás cambiar las credenciales, avisale.",
  });
}

// ── Intent 1: alias/CBU update ────────────────────────────────────────────────

export async function executeAliasUpdate(
  intent: AliasUpdateIntent,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  if (params.actorRole !== "owner") {
    return ownerOnlyReject("alias_update", params);
  }

  const seed = `credential-alias|${params.businessId}|${params.actorUserId}|${intent.alias}`;

  const result = await executeBusinessSetupActions(
    [{ intent: "update_business_setup", data: { field: "transferAlias", value: intent.alias }, summary: "Alias/CBU de transferencia actualizado" }],
    params.businessId,
    params.actorUserId,
    seed,
  );

  if (result.errors.length > 0) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "ALIAS_UPDATE_FAILED",
      a2a_transfer: false,
      message: "alias_update: persistSetupField failed",
      businessId: params.businessId,
      data: { errors: result.errors },
    });
    return NextResponse.json({
      answer: "No pude actualizar el alias. Intentá de nuevo en un momento.",
    });
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "ALIAS_UPDATE_COMPLETE",
    a2a_transfer: false,
    message: `alias_update: updated to ${intent.alias}`,
    businessId: params.businessId,
  });

  return NextResponse.json({
    answer: `Alias actualizado a ${intent.alias}. Tus cobros por transferencia ya van a este alias.`,
  });
}

// ── Intent 2: courier credential settings ────────────────────────────────────

export function executeCourierSettings(
  intent: CourierSettingsIntent,
  params: PreModelIntentParams,
): NextResponse {
  if (params.actorRole !== "owner") {
    return ownerOnlyReject("courier_settings", params);
  }

  const label = COURIER_LABELS[intent.provider];
  const panel = COURIER_PANEL[intent.provider];
  const help = COURIER_HELP[intent.provider];

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "COURIER_SETTINGS_REDIRECT",
    a2a_transfer: false,
    message: `courier_settings: opening ${panel}`,
    businessId: params.businessId,
    data: { provider: intent.provider },
  });

  const otherCouriers = (["andreani", "oca", "correo"] as CourierProvider[])
    .filter((p) => p !== intent.provider)
    .map((p) => ({ label: `Configurar ${COURIER_LABELS[p]}`, value: `configurar_courier:${p}` }));

  return NextResponse.json({
    answer:
      `Te abro los ajustes de ${label}. ` +
      `Vas a necesitar: ${help}. ` +
      `Los encontrás en el portal de ${label} para empresas.`,
    clientAction: "open_settings",
    clientActionParams: { panel },
    chipButtons: [
      { label: `Abrir ajustes ${label}`, value: `abrir_ajustes:${panel}` },
      ...otherCouriers,
    ],
  });
}

// ── Intent 3: MP OAuth re-trigger ─────────────────────────────────────────────

export async function executeMpOAuthReconnect(
  intent: MpOAuthReconnectIntent,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  if (params.actorRole !== "owner") {
    return ownerOnlyReject("mp_oauth_reconnect", params);
  }

  // Pre-flight: check if MP is already connected.
  const mp = await prisma.mpConnection.findUnique({
    where: { businessId: params.businessId },
    select: { id: true },
  });
  const alreadyConnected = mp !== null;

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "MP_OAUTH_RECONNECT_REQUESTED",
    a2a_transfer: false,
    message: `mp_oauth_reconnect: alreadyConnected=${alreadyConnected}`,
    businessId: params.businessId,
  });

  if (alreadyConnected) {
    // Ask for confirmation before re-triggering OAuth flow.
    return NextResponse.json({
      answer:
        "Ya tenés Mercado Pago conectado. ¿Querés reconectar? " +
        "Esto va a reemplazar la autorización actual.",
      confirmationRequest: {
        id: crypto.randomUUID(),
        severity: "warning",
        title: "Reconectar Mercado Pago",
        message: "Esto va a reemplazar la autorización actual de Mercado Pago.",
        confirmLabel: "Sí, reconectar",
        cancelLabel: "No, cancelar",
        action: { type: "open_mp_oauth" },
      },
    });
  }

  // Not connected — emit the OAuth clientAction directly.
  return NextResponse.json({
    answer:
      "Te inicio la conexión con Mercado Pago. " +
      "Vas a ser redirigido para autorizar.",
    clientAction: "open_mp_oauth",
  });
}

// ── Intent 4: generic service connect (MODO + ARCA) ──────────────────────────

const SERVICE_LABELS: Record<GenericService, string> = {
  modo: "MODO",
  arca: "ARCA/AFIP",
};

const SERVICE_PANEL: Record<GenericService, string> = {
  modo: "negocio.modo",
  arca: "negocio.fiscal",
};

const SERVICE_HELP: Record<GenericService, string> = {
  modo: "Client ID, Client Secret y Store ID de tu cuenta MODO de comercio",
  arca: "certificado digital de AFIP + contraseña + tu CUIT + condición de IVA",
};

export function executeServiceConnect(
  intent: ServiceConnectIntent,
  params: PreModelIntentParams,
): NextResponse {
  if (params.actorRole !== "owner") {
    return ownerOnlyReject(`service_connect:${intent.service}`, params);
  }

  const label = SERVICE_LABELS[intent.service];
  const panel = SERVICE_PANEL[intent.service];
  const help = SERVICE_HELP[intent.service];

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "SERVICE_CONNECT_REDIRECT",
    a2a_transfer: false,
    message: `service_connect: opening ${panel}`,
    businessId: params.businessId,
    data: { service: intent.service },
  });

  return NextResponse.json({
    answer:
      `Te abro los ajustes de ${label}. Vas a necesitar: ${help}. ` +
      `Los encontrás en el portal de ${label}.`,
    clientAction: "open_settings",
    clientActionParams: { panel },
    chipButtons: [
      { label: `Abrir ajustes ${label}`, value: `abrir_ajustes:${panel}` },
    ],
  });
}
