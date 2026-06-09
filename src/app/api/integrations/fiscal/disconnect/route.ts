// DELETE /api/integrations/fiscal/disconnect — owner-only.
//
// Removes the ARCA/AFIP credential for this business.
// Best-effort GCS cleanup + DB row deletion. Idempotent: a second call
// while the first is in flight returns a 409; a replayed identical key
// returns the cached 200.
//
// Mirrors integrations/mp/disconnect/route.ts.

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
import { disconnectArcaUseCase } from "./_lib/disconnect-use-case";

const MUTATION_ACTIONS = {
  DELETE: "arca_credential.disconnect",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.DELETE);

export async function DELETE(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;
  void ACTION_META;

  try {
    const result = await disconnectArcaUseCase({
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
      // Idempotent success — already disconnected.
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logRouteError("integrations/fiscal/disconnect", error);
    return internalError("No se pudo desconectar ARCA.");
  }
}
