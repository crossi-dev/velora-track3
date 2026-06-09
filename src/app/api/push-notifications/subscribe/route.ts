import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  checkRateLimit,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { pushSubscribeBodySchema } from "@/app/api/push-notifications/push-schema";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { createPushSubscriptionUseCase } from "@/application/use-cases/create-push-subscription.use-case";
import { prismaPushSubscriptionRepository } from "@/infrastructure/persistence/prisma-push-subscription.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";

const MUTATION_ACTIONS = {
  POST: "push-notifications.subscribe",
} as const satisfies RouteMutationDeclaration;
const SUBSCRIBE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

const subscribeUseCase = createPushSubscriptionUseCase({
  pushSubscription: prismaPushSubscriptionRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

// ── POST /api/push-notifications/subscribe ────────────────────────────────

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  try {
    const parsed = await parseZodBody(req, pushSubscribeBodySchema);
    if (!parsed.ok) return parsed.response;

    const endpoint = parsed.data.endpoint.trim();
    const p256dh = parsed.data.keys.p256dh.trim();
    const authKey = parsed.data.keys.auth.trim();
    const deviceLabel = parsed.data.deviceLabel?.trim() ?? null;
    if (!endpoint || !p256dh || !authKey) return badRequest("Las claves de la suscripción no pueden estar vacías.");

    const result = await subscribeUseCase.execute({
      businessId,
      actorUserId,
      actorEmployeeId,
      endpoint,
      p256dh,
      auth: authKey,
      deviceLabel,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: { endpoint, hasKeys: true, deviceLabel },
      actionMeta: SUBSCRIBE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return internalError("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return internalError("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return internalError("Operación en curso.");
    if (result.outcome !== "subscribed") return internalError("No se pudo registrar la suscripción.");

    return NextResponse.json({ ok: true });
  } catch (error) {
    logRouteError("push-notifications/subscribe", error);
    return internalError("No se pudo registrar la suscripción.");
  }
}
