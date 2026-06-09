// src/app/api/integrations/mp/connect-token/_lib/mp-connect-core.ts
//
// Core logic for the Bring-Your-Own-Account MercadoPago self-managed token
// connect flow. Extracted from the route handler so both the HTTP route and
// the MCP `connect_mercadopago` tool share the same validate+encrypt+upsert
// pipeline without duplicating credential-handling logic.
//
// Caller responsibilities:
//   - Auth gate (owner session / MCP tenant auth).
//   - Rate limiting.
//   - Idempotency (routes: beginIdempotentMutation; MCP: upsert is naturally
//     idempotent — same businessId always overwrites).
//   - Audit: callers pass `actorUserId` so the trace is correctly attributed.
//
// Token expiry: same 60-day default as the route handler (MP typically revokes
// self-managed tokens within 60–180 days when no expiration_date is present).
//
// References:
//   MP /users/me API: https://www.mercadopago.com.ar/developers/es/reference/oauth/_oauth_token/post
//   mpFetchWithRetry: src/app/api/agents/payments/jsonrpc/_lib/mp-fetch-retry.ts
//   encrypt: src/infrastructure/crypto/mp-token-cipher.ts

import { prisma } from "@/lib/prisma";
import { encrypt } from "@/infrastructure/crypto/mp-token-cipher";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { mpFetchWithRetry } from "@/app/api/agents/payments/jsonrpc/_lib/mp-fetch-retry";

const MP_USERS_ME = "https://api.mercadopago.com/users/me";

// 60-day fallback TTL — mirrors connect-token/route.ts.
const DEFAULT_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type MpConnectResult =
  | { ok: true; mpUserId: string }
  | { ok: false; code: "INVALID_TOKEN" | "MP_UNREACHABLE" | "UPSERT_FAILED"; message: string };

// ── Validation ────────────────────────────────────────────────────────────────

async function validateMpToken(
  token: string,
): Promise<{ ok: true; mpUserId: string; expiresAt: Date } | { ok: false; code: "INVALID_TOKEN" | "MP_UNREACHABLE"; message: string }> {
  let res: Response;
  try {
    res = await mpFetchWithRetry(
      (signal) => fetch(MP_USERS_ME, { headers: { Authorization: `Bearer ${token}` }, signal }),
      "mcp/connect-mercadopago/validate",
    );
  } catch {
    return { ok: false, code: "MP_UNREACHABLE", message: "No se pudo contactar MercadoPago. Reintentá en unos segundos." };
  }

  if (!res.ok) {
    return { ok: false, code: "INVALID_TOKEN", message: "El access token no es válido o expiró. Generalo desde developers.mercadopago.com.ar → Credenciales." };
  }

  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = null; }

  const obj = parsed as Record<string, unknown> | null;
  const userId = obj?.id != null ? String(obj.id) : null;
  if (!userId) {
    return { ok: false, code: "INVALID_TOKEN", message: "No se pudo leer el usuario MP. Verificá que el token sea de Producción." };
  }

  const rawExpiration = typeof obj?.expiration_date === "string" ? obj.expiration_date : null;
  let expiresAt: Date;
  if (rawExpiration) {
    const ts = Date.parse(rawExpiration);
    expiresAt = !isNaN(ts) ? new Date(ts) : new Date(Date.now() + DEFAULT_TOKEN_TTL_MS);
  } else {
    expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_MS);
  }

  return { ok: true, mpUserId: userId, expiresAt };
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Validates the MP access token against the MP API, encrypts it, and upserts
 * `MpConnection` for the given business. Returns the connected MP user ID on
 * success or a typed domain error.
 *
 * Called by:
 *   - POST /api/integrations/mp/connect-token (route.ts)
 *   - MCP tool `connect_mercadopago` (onboarding-tools.ts)
 */
export async function connectMercadoPago(args: {
  businessId: string;
  actorUserId: string;
  accessToken: string;
}): Promise<MpConnectResult> {
  const { businessId, actorUserId, accessToken } = args;

  const validation = await validateMpToken(accessToken);
  if (!validation.ok) {
    return { ok: false, code: validation.code, message: validation.message };
  }

  const { mpUserId, expiresAt } = validation;

  const data = {
    mpUserId,
    accessTokenCiphertext: encrypt(accessToken),
    refreshTokenCiphertext: null,
    liveMode: true,
    scope: "self-managed",
    expiresAt,
  };

  try {
    await prisma.mpConnection.upsert({
      where:  { businessId },
      create: { businessId, ...data },
      update: data,
    });
  } catch {
    return { ok: false, code: "UPSERT_FAILED", message: "No se pudo guardar la conexión. Reintentá." };
  }

  await recordCriticalWriteEvent({
    client:       prisma,
    businessId,
    actorUserId,
    actorEmployeeId: null,
    routeScope:   "integrations/mp/connect-token",
    actionType:   "mp_connection.connect_self_managed",
    resourceType: "mp_connection",
    resourceId:   businessId,
    summary:      `Cuenta MP self-managed conectada vía MCP (mpUserId=${mpUserId})`,
    payload:      { mpUserId, scope: "self-managed" },
  });

  return { ok: true, mpUserId };
}
