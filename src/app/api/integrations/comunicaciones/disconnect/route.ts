// DELETE /api/integrations/comunicaciones/disconnect — owner-only.
//
// Removes the BusinessChannelCredential row for the given provider.
// Idempotent: if the row does not exist the response is still { ok: true }.
// businessId is ALWAYS derived from the authenticated session — never from the
// request body.

import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  internalError,
  jsonError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  VALID_PROVIDERS,
  type ChannelProvider,
} from "../connect/_lib/credential-validators";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";

const MUTATION_ACTIONS = {
  DELETE: "channel_credential.disconnect",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.DELETE);

// ── Route handler ─────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  // ── 1. Auth: owner only ────────────────────────────────────────────────────
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;
  void ACTION_META;

  // ── 2. Rate limit ──────────────────────────────────────────────────────────
  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  // ── 3. Parse JSON body ─────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("INVALID_BODY", "Expected JSON body with provider.", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("INVALID_BODY", "Body must be a JSON object.", 400);
  }

  const raw = body as Record<string, unknown>;
  const provider = raw.provider;

  if (typeof provider !== "string" || !(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    return jsonError(
      "INVALID_PROVIDER",
      `provider must be one of: ${VALID_PROVIDERS.join(", ")}.`,
      400,
    );
  }

  const typedProvider = provider as ChannelProvider;

  // ── 4. Delete — idempotent (no row = still ok) ────────────────────────────
  try {
    await prisma.businessChannelCredential.deleteMany({
      where: { businessId: ctx.businessId, provider: typedProvider },
    });
  } catch (err) {
    logRouteError("integrations/comunicaciones/disconnect", err, { stage: "db_delete" });
    return internalError("No se pudo eliminar la credencial. Intentá de nuevo.");
  }

  // ── 5. Audit ───────────────────────────────────────────────────────────────
  await recordCriticalWriteEvent({
    client:          prisma,
    businessId:      ctx.businessId,
    actorUserId:     ctx.actorUserId,
    actorEmployeeId: ctx.actorEmployeeId,
    routeScope:      "integrations/comunicaciones/disconnect",
    actionType:      "channel_credential.disconnect",
    resourceType:    "channel_credential",
    resourceId:      ctx.businessId,
    summary:         `Credencial de canal de comunicación eliminada: ${typedProvider}`,
    payload:         { provider: typedProvider },
  });

  return NextResponse.json({ ok: true });
}
