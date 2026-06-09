import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  bypassIfTester,
  checkRateLimit,
  conflict,
  internalError,
  logRouteError,
  notFound,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { createPaymentIntentUseCase } from "../_lib/payment-intent-use-case";
import { createPaymentIntentBodySchema } from "../_lib/schemas";
import { runWithTraceContext } from "@/lib/cloud-logger";

const MUTATION_ACTIONS = {
  POST: "payment_intent.create",
} as const satisfies RouteMutationDeclaration;
// Binding requerido por el contract checker (regex
// `getServerActionMeta\(MUTATION_ACTIONS\.POST\)`).
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  // Cobro QR es un flujo del empleado en piso — owner también puede,
  // así que NO restringimos rol acá. Defense in depth: el handler del
  // chat ya gatea via deterministic NLU + RBAC standard.

  try {
    const parsed = await parseZodBody(req, createPaymentIntentBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await createPaymentIntentUseCase({
      businessId: ctx.businessId,
      actorUserId: ctx.actorUserId,
      actorEmployeeId: ctx.actorEmployeeId,
      saleId: parsed.data.saleId ?? null,
      monto: parsed.data.monto,
      metodo: parsed.data.metodo,
      idempotencyKey: getIdempotencyKey(req),
      actionMeta: ACTION_META,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome === "sale_not_found") return notFound("Venta no encontrada.");
    if (result.outcome !== "created") return internalError("No se pudo crear el cobro.");

    return NextResponse.json(result.intent, { status: 201 });
  } catch (error) {
    logRouteError("payment-intents/create", error);
    return internalError("No se pudo crear el cobro.");
  }
}
