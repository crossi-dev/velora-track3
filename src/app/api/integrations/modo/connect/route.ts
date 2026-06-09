// POST /api/integrations/modo/connect — owner-only.
//
// Stores per-business MODO payment credentials (bring-your-own-account).
// Credential fields (from open-source WP plugin + onboarding guide):
//   clientId     — MODO-assigned client identifier (username)
//   clientSecret — MODO-assigned secret (password)
//   storeId      — MODO-assigned store ID
//
// Flow:
//   1. Rate-limit (upload bucket — 10 req/min).
//   2. Auth: resolveActor + requireRole(owner).
//   3. Parse + validate JSON body: { credentials: { clientId, clientSecret, storeId } }.
//   4. Preflight: attempt real MODO auth call to validate credentials.
//      401/403 → 422 (bad credentials, non-transient).
//      5xx/timeout → 422 (transient, retry later).
//   5. Encrypt credentials (AES-256-GCM).
//   6. Upsert ModoConnection.
//   7. recordCriticalWriteEvent (actionType: "modo_connection.upsert").
//   8. Return { ok: true }.
//
// Security:
//   - businessId is ALWAYS derived from the authenticated session — never from body.
//   - Credential plaintext NEVER appears in logs, responses, or audit payload.

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
import { validateModoCreds, ModoPreflightError } from "./_lib/modo-preflight";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";

const MUTATION_ACTIONS = {
  POST: "modo_connection.upsert",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

// ── Route handler ─────────────────────────────────────────────────────────────

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
  void ACTION_META;

  // ── 3. Parse + validate JSON body ────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("INVALID_BODY", "Expected JSON body with credentials field.", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("INVALID_BODY", "Body must be a JSON object.", 400);
  }

  const raw = body as Record<string, unknown>;
  const credentials = raw.credentials;

  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    return jsonError(
      "INVALID_CREDENTIALS",
      "credentials must be a non-null JSON object.",
      400,
    );
  }

  const credsObj = credentials as Record<string, unknown>;

  // Validate required MODO fields — clientId, clientSecret, storeId.
  const clientId = typeof credsObj.clientId === "string" ? credsObj.clientId.trim() : "";
  const clientSecret = typeof credsObj.clientSecret === "string" ? credsObj.clientSecret.trim() : "";
  const storeId = typeof credsObj.storeId === "string" ? credsObj.storeId.trim() : "";

  if (!clientId) {
    return jsonError("INVALID_CREDENTIALS", "Falta el campo clientId de MODO.", 422);
  }
  if (!clientSecret) {
    return jsonError("INVALID_CREDENTIALS", "Falta el campo clientSecret de MODO.", 422);
  }
  if (!storeId) {
    return jsonError("INVALID_CREDENTIALS", "Falta el campo storeId de MODO.", 422);
  }

  // ── 4. Preflight: validate credentials against MODO API ──────────────────
  try {
    await validateModoCreds({ clientId, clientSecret, storeId });
  } catch (err) {
    if (err instanceof ModoPreflightError) {
      return jsonError(
        err.transient ? "MODO_UNAVAILABLE" : "INVALID_CREDENTIALS",
        err.spanishMessage,
        422,
      );
    }
    logRouteError("integrations/modo/connect", err, { stage: "preflight" });
    return internalError("Error al verificar las credenciales MODO. Intentá de nuevo.");
  }

  // ── 5. Encrypt credentials (AES-256-GCM) ────────────────────────────────
  // Store only the canonical three fields — never extraneous keys.
  const canonicalCreds = { clientId, clientSecret, storeId };
  let encryptedCredentials: string;
  try {
    encryptedCredentials = encrypt(JSON.stringify(canonicalCreds));
  } catch (err) {
    logRouteError("integrations/modo/connect", err, { stage: "encrypt" });
    return internalError("Error de encriptación. Contactá soporte.");
  }

  // ── 6. Upsert ModoConnection ─────────────────────────────────────────────
  // businessId is ALWAYS from the authenticated session — never trust request body.
  try {
    await prisma.modoConnection.upsert({
      where: { businessId: ctx.businessId },
      create: { businessId: ctx.businessId, encryptedCredentials },
      update: { encryptedCredentials },
    });
  } catch (err) {
    logRouteError("integrations/modo/connect", err, { stage: "db_upsert" });
    return internalError("No se pudo guardar la credencial MODO. Intentá de nuevo.");
  }

  // ── 7. Audit ─────────────────────────────────────────────────────────────
  await recordCriticalWriteEvent({
    client: prisma,
    businessId: ctx.businessId,
    actorUserId: ctx.actorUserId,
    actorEmployeeId: ctx.actorEmployeeId,
    routeScope: "integrations/modo/connect",
    actionType: "modo_connection.upsert",
    resourceType: "modo_connection",
    resourceId: ctx.businessId,
    summary: "Credencial MODO actualizada",
    // Intentionally excludes credential values — only storeId (non-secret) is safe.
    payload: { storeId },
  });

  return NextResponse.json({ ok: true });
}
