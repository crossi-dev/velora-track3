// POST /api/integrations/mp/disconnect — owner-only.
//
// Borra la MpConnection del negocio. Mutation contract pattern (idempotency
// + critical-write audit). Best effort: si el usuario aprieta dos veces
// seguidas, la segunda devuelve replay del primer 200.

import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  bypassIfTester,
  checkRateLimit,
  conflict,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";
import { disconnectMpUseCase } from "../_lib/disconnect-use-case";

const MUTATION_ACTIONS = {
  POST: "mp_connection.disconnect",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

export async function POST(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;
  void ACTION_META;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  try {
    const result = await disconnectMpUseCase({
      businessId: ctx.businessId,
      actorUserId: ctx.actorUserId,
      actorEmployeeId: ctx.actorEmployeeId,
      idempotencyKey: getIdempotencyKey(req),
    });

    if (result.outcome === "replayed") {
      return NextResponse.json(result.body, { status: result.status });
    }
    if (result.outcome === "idempotency_missing") {
      return badRequest("Falta X-Idempotency-Key.");
    }
    if (result.outcome === "idempotency_conflict") {
      return conflict("Conflicto de idempotencia.");
    }
    if (result.outcome === "idempotency_in_flight") {
      return conflict("Operación en curso.");
    }
    if (result.outcome === "not_connected") {
      return NextResponse.json({ ok: true, mpUserId: null }, { status: 200 });
    }
    return NextResponse.json({ ok: true, mpUserId: result.mpUserId }, { status: 200 });
  } catch (error) {
    logRouteError("integrations/mp/disconnect", error);
    return internalError("No se pudo desconectar Mercado Pago.");
  }
}
