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
import { refundPaymentIntentUseCase } from "../_lib/refund-use-case";
import { refundPaymentIntentBodySchema } from "../_lib/schemas";
import { enforcePolicy, policyDeniedResponse } from "@/app/api/_lib/policy-evaluator";
import { requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { runWithTraceContext } from "@/lib/cloud-logger";

const MUTATION_ACTIONS = {
  POST: "payment_intent.refund",
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
  // return_sale es owner-only (role-contract.ts OWNER_ONLY_INTENTS). Empleados
  // no pueden emitir devoluciones directas — enforcePolicy no es suficiente
  // porque un bypass de política dejaría pasar a cualquier empleado.
  const roleCheck = requireRole(ctx, ["owner"]);
  if (roleCheck) return roleCheck;
  void ACTION_META;

  try {
    const parsed = await parseZodBody(req, refundPaymentIntentBodySchema);
    if (!parsed.ok) return parsed.response;

    // Enforce DelegationPolicy(scope="return") before executing the refund.
    // Owners bypass automatically (evaluator is a no-op for owner role).
    // Employees are subject to maxReturnAmount if a return policy is active.
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: parsed.data.paymentIntentId, businessId: ctx.businessId },
      select: { monto: true },
    });
    const refundAmount = intent ? Number(intent.monto) : null;
    const policyDecision = await enforcePolicy({
      businessId: ctx.businessId,
      actorId: ctx.actorEmployeeId ?? ctx.actorUserId,
      actorRole: ctx.role,
      action: { type: "return-sale", data: { amount: refundAmount } },
    });
    if (!policyDecision.allowed) return policyDeniedResponse(policyDecision);

    const result = await refundPaymentIntentUseCase({
      businessId: ctx.businessId,
      actorUserId: ctx.actorUserId,
      actorEmployeeId: ctx.actorEmployeeId,
      paymentIntentId: parsed.data.paymentIntentId,
      idempotencyKey: getIdempotencyKey(req),
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome === "not_found") return notFound("No se encontró el cobro.");
    if (result.outcome === "not_confirmed") {
      // Rechazo de estado inválido — solo confirmed → refunded. Pending/expired/
      // refunded caen acá. Devolvemos 400 con code semántico para que la card
      // muestre el mensaje correcto inline.
      return NextResponse.json(
        {
          code: "NOT_CONFIRMED",
          message: `El cobro está en estado "${result.estado}" y no puede devolverse.`,
        },
        { status: 400 },
      );
    }
    if (result.outcome !== "refunded") return internalError("No se pudo devolver el cobro.");

    return NextResponse.json(
      {
        ok: true,
        paymentIntentId: result.paymentIntentId,
        saleId: result.saleId,
        monto: result.monto,
        refundedAt: result.refundedAt,
      },
      { status: 200 },
    );
  } catch (error) {
    logRouteError("payment-intents/refund", error);
    return internalError("No se pudo devolver el cobro.");
  }
}
