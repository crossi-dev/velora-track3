// POST /api/integrations/logistica/connect — owner-only.
//
// Stores per-business courier credentials for Andreani, OCA, or Correo Argentino.
// Credentials are AES-256-GCM encrypted before storage (same key as MP tokens).
//
// Credential shapes:
//   Andreani: { clientId, clientSecret, contratoDomicilio, contratoSucursal, contratoExpress }
//   OCA:      { usuario, password, cuit, operativa, nroCuenta }
//   Correo:   { username, password }
//             customerId is resolved by preflight (POST /Users/validate) and auto-merged.
//
// Flow:
//   1. Rate-limit (upload bucket — 10 req/min).
//   2. Auth: resolveActor + requireRole(owner).
//   3. Parse + validate JSON body.
//   4. Validate credential shape per provider (credential-validators.ts).
//   5. Provider preflight — validate against real API before persisting:
//        Andreani: POST /Token  → 401/403 → non-transient 422.
//        OCA:      loginSigma  → 401/403 → non-transient 422.
//        Correo:   POST /Token → POST /Users/validate → customerId injected into creds.
//   6. Encrypt credentials (AES-256-GCM).
//   7. Upsert CourierCredential.
//   8. recordCriticalWriteEvent.
//   9. Return { ok: true }.
//
// Security:
//   - businessId is ALWAYS derived from the authenticated session — never from request body.
//   - Credential plaintext NEVER appears in logs, responses, or audit payload.
//   - Only the ciphertext is stored; decryption happens in the courier API client.

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
import { validateAndreaniCreds, AndreaniPreflightError } from "./_lib/andreani-preflight";
import { validateOcaCreds, OcaPreflightError } from "./_lib/oca-preflight";
import { validateCorreoCreds, CorreoPreflightError } from "./_lib/correo-preflight";
import { validateCredentials, VALID_PROVIDERS, type CourierProvider } from "./_lib/credential-validators";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";

// ── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── 1. Auth: owner only ──────────────────────────────────────────────────
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  // ── 2. Rate limit ────────────────────────────────────────────────────────
  const rateLimited = checkRateLimitUpload(req, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  // ── 3. Parse JSON body ───────────────────────────────────────────────────
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

  // ── 4. Validate credential shape per provider ────────────────────────────
  const validation = validateCredentials(
    provider as CourierProvider,
    credentials as Record<string, unknown>,
  );
  if (!validation.ok) {
    return jsonError("INVALID_CREDENTIALS", validation.error ?? "Invalid credentials.", 422);
  }

  // ── 5. Provider preflight — validate against real API before persisting ──

  if (provider === "andreani") {
    const creds = credentials as Record<string, unknown>;
    const clientId     = typeof creds.clientId     === "string" ? creds.clientId     : "";
    const clientSecret = typeof creds.clientSecret === "string" ? creds.clientSecret : "";
    try {
      await validateAndreaniCreds(clientId, clientSecret);
    } catch (err) {
      if (err instanceof AndreaniPreflightError) {
        // Transient errors (network, API unavailable) — save anyway so users are not blocked.
        // Non-transient (401/403 credential rejection) — return error.
        if (!err.transient) {
          return jsonError("ANDREANI_PREFLIGHT_FAILED", err.spanishMessage, 422);
        }
        logRouteError("integrations/logistica/connect", err, { stage: "andreani_preflight_transient" });
      } else {
        logRouteError("integrations/logistica/connect", err, { stage: "andreani_preflight" });
      }
    }
  }

  if (provider === "oca") {
    const creds  = credentials as Record<string, unknown>;
    const usuario  = typeof creds.usuario  === "string" ? creds.usuario  : "";
    const password = typeof creds.password === "string" ? creds.password : "";
    try {
      await validateOcaCreds(usuario, password);
    } catch (err) {
      if (err instanceof OcaPreflightError) {
        if (!err.transient) {
          return jsonError("OCA_PREFLIGHT_FAILED", err.spanishMessage, 422);
        }
        logRouteError("integrations/logistica/connect", err, { stage: "oca_preflight_transient" });
      } else {
        logRouteError("integrations/logistica/connect", err, { stage: "oca_preflight" });
      }
    }
  }

  // Correo preflight: POST /Token → POST /Users/validate → inject customerId.
  // customerId is merged into stored credentials so adapter never calls validate at runtime.
  // If the preflight fails transiently (API URL wrong, network error), save without customerId.
  let finalCredentials: Record<string, unknown> = credentials as Record<string, unknown>;

  if (provider === "correo") {
    const creds    = credentials as Record<string, unknown>;
    const username = typeof creds.username === "string" ? creds.username : "";
    const password = typeof creds.password === "string" ? creds.password : "";
    try {
      const preflightResult = await validateCorreoCreds(username, password);
      finalCredentials = { ...creds, customerId: preflightResult.customerId };
    } catch (err) {
      if (err instanceof CorreoPreflightError) {
        if (!err.transient) {
          return jsonError("CORREO_PREFLIGHT_FAILED", err.spanishMessage, 422);
        }
        // Transient (404, network, timeout) — save credentials without customerId.
        // customerId will be resolved on first use when the API is reachable.
        logRouteError("integrations/logistica/connect", err, { stage: "correo_preflight_transient" });
      } else {
        logRouteError("integrations/logistica/connect", err, { stage: "correo_preflight" });
      }
    }
  }

  // ── 6. Encrypt credentials (AES-256-GCM) ────────────────────────────────
  let encryptedCredentials: string;
  try {
    encryptedCredentials = encrypt(JSON.stringify(finalCredentials));
  } catch (err) {
    logRouteError("integrations/logistica/connect", err, { stage: "encrypt" });
    return internalError("Error de encriptación. Contactá soporte.");
  }

  // ── 7. Upsert CourierCredential ──────────────────────────────────────────
  // businessId is ALWAYS from the authenticated session — never trust request body.
  try {
    await prisma.courierCredential.upsert({
      where:  { businessId_provider: { businessId: ctx.businessId, provider } },
      create: { businessId: ctx.businessId, provider, encryptedCredentials, environment },
      update: { encryptedCredentials, environment },
    });
  } catch (err) {
    logRouteError("integrations/logistica/connect", err, { stage: "db_upsert" });
    return internalError("No se pudo guardar la credencial. Intentá de nuevo.");
  }

  // ── 8. Audit ─────────────────────────────────────────────────────────────
  await recordCriticalWriteEvent({
    client:          prisma,
    businessId:      ctx.businessId,
    actorUserId:     ctx.actorUserId,
    actorEmployeeId: ctx.actorEmployeeId,
    routeScope:      "integrations/logistica/connect",
    actionType:      "courier_credential.upsert",
    resourceType:    "courier_credential",
    resourceId:      ctx.businessId,
    summary:         `Credencial de courier conectada: ${provider}`,
    payload:         { provider, environment },
  });

  return NextResponse.json({ ok: true });
}
