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
import { confirmPaymentIntentUseCase } from "../_lib/payment-intent-use-case";
import { runPostConfirmSideEffects } from "../_lib/payment-intent-post-confirm";
import { confirmPaymentIntentBodySchema } from "../_lib/schemas";
import { runWithTraceContext } from "@/lib/cloud-logger";

const MUTATION_ACTIONS = {
  POST: "payment_intent.confirm",
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
  // EMPLOYEE_ALLOWED: cobro QR — el empleado en caja confirma el pago
  // (role-contract.ts EMPLOYEE_ALLOWED_INTENTS: "cobro_qr").

  try {
    const parsed = await parseZodBody(req, confirmPaymentIntentBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await confirmPaymentIntentUseCase({
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
    if (result.outcome === "already_confirmed") {
      return NextResponse.json(
        { code: "ALREADY_CONFIRMED", message: "El cobro ya estaba confirmado." },
        { status: 409 },
      );
    }
    // Slice 3 — Timeout 2 min: 410 GONE para que el cliente sepa que el
    // intent quedó muerto y tiene que regenerar el cobro.
    if (result.outcome === "expired") {
      return NextResponse.json(
        { code: "EXPIRED", message: "Cobro expirado, generá uno nuevo" },
        { status: 410 },
      );
    }
    if (result.outcome !== "confirmed") return internalError("No se pudo confirmar el cobro.");

    // Await side effects (WPP comprobante + Andreani shipment + WPP tracking)
    // before responding. Manual confirms run in Cloud Run with no time pressure
    // from Cloud Tasks, so awaiting here is safe and guarantees the full
    // post-confirm chain runs before the response is sent.
    // A side-effect failure is non-fatal for the HTTP response; we catch and log.
    try {
      await runPostConfirmSideEffects(result.paymentIntentId, ctx.businessId);
    } catch {
      // Side effects log internally. The confirm is already durable — do not
      // surface a 500 to the UI for a Twilio/Andreani transient error.
    }

    return NextResponse.json(
      { ok: true, paymentIntentId: result.paymentIntentId, saleId: result.saleId },
      { status: 200 },
    );
  } catch (error) {
    logRouteError("payment-intents/confirm", error);
    return internalError("No se pudo confirmar el cobro.");
  }
}
