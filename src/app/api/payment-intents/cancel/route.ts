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
import { cancelPaymentIntentUseCase } from "../_lib/cancel-payment-intent-use-case";
import { cancelPaymentIntentBodySchema } from "../_lib/schemas";
import { runWithTraceContext } from "@/lib/cloud-logger";

const MUTATION_ACTIONS = {
  POST: "payment_intent.cancel",
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
  // EMPLOYEE_ALLOWED: cobro QR — el empleado en caja puede cancelar un cobro
  // pendiente (role-contract.ts COMPANION_ALLOWED_INTENTS: "cobro_qr").

  try {
    const parsed = await parseZodBody(req, cancelPaymentIntentBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await cancelPaymentIntentUseCase({
      businessId: ctx.businessId,
      actorUserId: ctx.actorUserId,
      actorEmployeeId: ctx.actorEmployeeId,
      paymentIntentId: parsed.data.paymentIntentId,
      idempotencyKey: getIdempotencyKey(req),
      actionMeta: ACTION_META,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome === "not_found") return notFound("No se encontró el cobro.");
    if (result.outcome === "not_cancellable") {
      return NextResponse.json(
        {
          code: "NOT_CANCELLABLE",
          message: `El cobro está en estado "${result.estado}" y no puede cancelarse.`,
        },
        { status: 409 },
      );
    }
    if (result.outcome !== "cancelled") return internalError("No se pudo cancelar el cobro.");

    return NextResponse.json(
      { ok: true, paymentIntentId: result.paymentIntentId },
      { status: 200 },
    );
  } catch (error) {
    logRouteError("payment-intents/cancel", error);
    return internalError("No se pudo cancelar el cobro.");
  }
}
