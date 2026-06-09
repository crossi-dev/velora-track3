// src/app/api/integrations/comunicaciones/connect/_lib/pedidosya-connect-core.ts
//
// Core logic for connecting a PedidosYa credential. Currently used by the MCP
// `connect_pedidosya` tool only. The HTTP route
// (POST /api/integrations/comunicaciones/connect) handles multiple providers
// (twilio_sms, resend, pedidosya) through a shared generic path — refactoring
// it to delegate PedidosYa to this core is tracked as a future cleanup.
//
// NOTE: do NOT update this header to claim the HTTP route delegates here until
// that refactor is done.
//
// Shape validation (required fields present + non-empty) is the gate —
// no live API preflight is done (transient network failures must not block
// credential storage; auth failures surface on first use).
//
// References:
//   credential-validators.ts — shape validation for all channel providers
//   encrypt: src/infrastructure/crypto/mp-token-cipher.ts (AES-256-GCM, same key)
//   BusinessChannelCredential model — businessId_provider unique constraint

import { prisma } from "@/lib/prisma";
import { encrypt } from "@/infrastructure/crypto/mp-token-cipher";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PedidosYaConnectResult =
  | { ok: true }
  | { ok: false; code: "INVALID_TOKEN" | "ENCRYPT_FAILED" | "UPSERT_FAILED"; message: string };

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Encrypts the PedidosYa apiToken and upserts a `BusinessChannelCredential`
 * row (provider="pedidosya") for the given business. Emits a CriticalWriteEvent.
 *
 * Called by:
 *   - MCP tool `connect_pedidosya` (onboarding-tools.ts)
 * Pending:
 *   - POST /api/integrations/comunicaciones/connect (route.ts) — not yet delegated here
 */
export async function connectPedidosYa(args: {
  businessId: string;
  actorUserId: string;
  apiToken: string;
}): Promise<PedidosYaConnectResult> {
  const { businessId, actorUserId, apiToken } = args;

  if (!apiToken || typeof apiToken !== "string" || apiToken.trim() === "") {
    return { ok: false, code: "INVALID_TOKEN", message: "El apiToken de PedidosYa es requerido y no puede estar vacío." };
  }

  const credentials = { apiToken: apiToken.trim() };

  let encryptedCredentials: string;
  try {
    encryptedCredentials = encrypt(JSON.stringify(credentials));
  } catch {
    return { ok: false, code: "ENCRYPT_FAILED", message: "Error de encriptación. Contactá soporte." };
  }

  try {
    await prisma.businessChannelCredential.upsert({
      where:  { businessId_provider: { businessId, provider: "pedidosya" } },
      create: { businessId, provider: "pedidosya", encryptedCredentials, environment: "production" },
      update: { encryptedCredentials, environment: "production" },
    });
  } catch {
    return { ok: false, code: "UPSERT_FAILED", message: "No se pudo guardar la credencial. Intentá de nuevo." };
  }

  await recordCriticalWriteEvent({
    client:       prisma,
    businessId,
    actorUserId,
    actorEmployeeId: null,
    routeScope:   "integrations/comunicaciones/connect",
    actionType:   "channel_credential.upsert",
    resourceType: "channel_credential",
    resourceId:   businessId,
    summary:      "Credencial PedidosYa conectada vía MCP",
    payload:      { provider: "pedidosya", environment: "production" },
  });

  return { ok: true };
}
