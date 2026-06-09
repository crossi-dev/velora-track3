// POST /api/integrations/comunicaciones/connect — owner-only.
//
// Stores per-business communication channel credentials for Twilio SMS, Resend
// email, and PedidosYa delivery. BYOA (Bring Your Own Account) model — each
// business connects its own third-party account.
//
// Credential shapes:
//   twilio_sms: { accountSid, authToken, from }
//   resend:     { apiKey, from? }
//   pedidosya:  { apiToken }
//
// Flow:
//   1. Auth: resolveActor + requireRole(owner).
//   2. Rate limit (upload bucket — 10 req/min).
//   3. Parse + validate JSON body.
//   4. Validate provider (must be one of VALID_PROVIDERS).
//   5. Validate credential shape per provider.
//   6. Lightweight preflight: format/shape validated above; API-level validation
//      is deferred — transient network errors must NOT block credential storage.
//   7. Encrypt credentials (AES-256-GCM).
//   8. Upsert BusinessChannelCredential.
//   9. recordCriticalWriteEvent.
//  10. Return { ok: true }.
//
// Security:
//   - businessId is ALWAYS derived from the authenticated session — never from body.
//   - Credential plaintext NEVER appears in logs, responses, or audit payload.
//   - Only the ciphertext is stored; decryption happens in the channel clients.

import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimitUpload,
  jsonError,
  internalError,
  logRouteError,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/infrastructure/crypto/mp-token-cipher";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  VALID_PROVIDERS,
  type ChannelProvider,
  validateCredentialShape,
} from "./_lib/credential-validators";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";

const MUTATION_ACTIONS = {
  POST: "channel_credential.upsert",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  void ACTION_META;
  // ── 1. Auth: owner only ────────────────────────────────────────────────────
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  // ── 2. Rate limit ──────────────────────────────────────────────────────────
  const rateLimited = checkRateLimitUpload(req, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  // ── 3. Parse JSON body ─────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("INVALID_BODY", "Expected JSON body with provider + credentials.", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("INVALID_BODY", "Body must be a JSON object.", 400);
  }

  const raw = body as Record<string, unknown>;
  const provider = raw.provider;
  const credentials = raw.credentials;
  const rawEnvironment = raw.environment;
  const environment: "production" | "sandbox" =
    rawEnvironment === "sandbox" ? "sandbox" : "production";

  // ── 4. Validate provider ───────────────────────────────────────────────────
  if (typeof provider !== "string" || !(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    return jsonError(
      "INVALID_PROVIDER",
      `provider must be one of: ${VALID_PROVIDERS.join(", ")}.`,
      400,
    );
  }

  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    return jsonError("INVALID_CREDENTIALS", "credentials must be a non-null JSON object.", 400);
  }

  // ── 5. Validate credential shape per provider ──────────────────────────────
  const validation = validateCredentialShape(
    provider as ChannelProvider,
    credentials as Record<string, unknown>,
  );
  if (!validation.ok) {
    return jsonError("INVALID_CREDENTIALS", validation.error ?? "Invalid credentials.", 422);
  }

  // ── 6. No blocking API preflight — shape validation is the gate. ───────────
  // Transient network errors must never prevent credential storage.
  // Clear auth failures (401/403) from provider APIs are not pre-tested here;
  // the send operations will surface them on first use.

  // ── 7. Encrypt credentials (AES-256-GCM) ──────────────────────────────────
  let encryptedCredentials: string;
  try {
    encryptedCredentials = encrypt(JSON.stringify(credentials));
  } catch (err) {
    logRouteError("integrations/comunicaciones/connect", err, { stage: "encrypt" });
    return internalError("Error de encriptación. Contactá soporte.");
  }

  // ── 8. Upsert BusinessChannelCredential ───────────────────────────────────
  // businessId is ALWAYS from the authenticated session — never trust request body.
  try {
    await prisma.businessChannelCredential.upsert({
      where:  { businessId_provider: { businessId: ctx.businessId, provider } },
      create: { businessId: ctx.businessId, provider, encryptedCredentials, environment },
      update: { encryptedCredentials, environment },
    });
  } catch (err) {
    logRouteError("integrations/comunicaciones/connect", err, { stage: "db_upsert" });
    return internalError("No se pudo guardar la credencial. Intentá de nuevo.");
  }

  // ── 9. Audit ───────────────────────────────────────────────────────────────
  await recordCriticalWriteEvent({
    client:          prisma,
    businessId:      ctx.businessId,
    actorUserId:     ctx.actorUserId,
    actorEmployeeId: ctx.actorEmployeeId,
    routeScope:      "integrations/comunicaciones/connect",
    actionType:      "channel_credential.upsert",
    resourceType:    "channel_credential",
    resourceId:      ctx.businessId,
    summary:         `Credencial de canal de comunicación conectada: ${provider}`,
    payload:         { provider, environment },
  });

  return NextResponse.json({ ok: true });
}
