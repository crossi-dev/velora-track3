import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { pushSubscribeBodySchema } from "@/app/api/push-notifications/push-schema";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["employee"]);
  if (forbidden) return forbidden;
  const { businessId, actorEmployeeId } = ctx;

  const parsed = await parseZodBody(req, pushSubscribeBodySchema);
  if (!parsed.ok) return parsed.response;

  const { endpoint, keys, deviceLabel } = parsed.data;

  try {
    await prisma.pushSubscription.upsert({
      where: { businessId_endpoint: { businessId, endpoint } },
      update: { userId: actorEmployeeId!, p256dh: keys.p256dh, auth: keys.auth, expired: false, deviceLabel: deviceLabel ?? null },
      create: { businessId, userId: actorEmployeeId!, endpoint, p256dh: keys.p256dh, auth: keys.auth, deviceLabel: deviceLabel ?? null },
    });
    console.info("EMPLOYEE_PUSH_SUBSCRIBED", { businessId, actorEmployeeId, deviceLabel: deviceLabel ?? null });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logRouteError("push-notifications/employee-subscribe", error);
    return NextResponse.json({ code: "SUBSCRIBE_FAILED", message: "No se pudo registrar la suscripción." }, { status: 500 });
  }
}
