// POST /api/integrations/modo/disconnect — owner-only.
//
// Deletes the ModoConnection row for the authenticated business.
// Idempotent: if the row does not exist, returns { ok: true } (already disconnected).
// Mirrors the MP disconnect pattern (src/app/api/integrations/mp/disconnect/route.ts).

import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  jsonError,
  internalError,
  logRouteError,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";

const MUTATION_ACTIONS = {
  POST: "modo_connection.disconnect",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

export async function POST(req: NextRequest) {
  // ── Auth: owner only ─────────────────────────────────────────────────────
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  // ── Rate limit ───────────────────────────────────────────────────────────
  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;
  void ACTION_META;

  // ── Delete ModoConnection ─────────────────────────────────────────────────
  try {
    const existing = await prisma.modoConnection.findUnique({
      where: { businessId: ctx.businessId },
      select: { id: true },
    });

    if (!existing) {
      // Already disconnected — idempotent 200.
      return NextResponse.json({ ok: true, alreadyDisconnected: true });
    }

    await prisma.modoConnection.delete({
      where: { businessId: ctx.businessId },
    });
  } catch (err) {
    logRouteError("integrations/modo/disconnect", err);
    return internalError("No se pudo desconectar MODO. Intentá de nuevo.");
  }

  // ── Audit ─────────────────────────────────────────────────────────────────
  await recordCriticalWriteEvent({
    client: prisma,
    businessId: ctx.businessId,
    actorUserId: ctx.actorUserId,
    actorEmployeeId: ctx.actorEmployeeId,
    routeScope: "integrations/modo/disconnect",
    actionType: "modo_connection.disconnect",
    resourceType: "modo_connection",
    resourceId: ctx.businessId,
    summary: "Cuenta MODO desconectada",
    payload: {},
  });

  return NextResponse.json({ ok: true });
}
