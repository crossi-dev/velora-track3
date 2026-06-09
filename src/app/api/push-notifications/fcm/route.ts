// POST /api/push-notifications/fcm
// Registers an FCM token for a native Capacitor Android device.
// Accepts both owner and employee sessions — the FCM token is tied to the
// actor (owner userId or employee employeeId) and the business.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";

const fcmSubscribeBodySchema = z.object({
  fcmToken: z.string().min(1).max(512),
  deviceLabel: z.string().max(100).optional(),
}).strict();

// FCM tokens use the fcmToken value as the dedup key (mapped to the `endpoint`
// column) so the existing @@unique([businessId, endpoint]) constraint covers
// upserts without a schema change for the unique index.
//
// Convention: endpoint = "fcm:<token>" — keeps Web Push endpoints
// (always starting with "https://") distinct from FCM entries in queries
// that filter by endpoint.

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();

  // Both owner and employee may register an FCM token.
  const { businessId, actorUserId, actorEmployeeId } = ctx;
  const userId = actorEmployeeId ?? actorUserId;

  const parsed = await parseZodBody(req, fcmSubscribeBodySchema);
  if (!parsed.ok) return parsed.response;

  const { fcmToken, deviceLabel } = parsed.data;
  // Synthetic endpoint so the existing unique index is satisfied without a
  // new index. Max 512 chars for the raw token; prefix adds 4 chars.
  const endpointKey = `fcm:${fcmToken}`;

  try {
    await prisma.pushSubscription.upsert({
      where: { businessId_endpoint: { businessId, endpoint: endpointKey } },
      update: {
        userId,
        kind: "fcm",
        fcmToken,
        endpoint: endpointKey,
        // p256dh and auth are Web Push fields — irrelevant for FCM.
        // Keep existing values on update to avoid constraint issues.
        expired: false,
        deviceLabel: deviceLabel ?? null,
      },
      create: {
        businessId,
        userId,
        kind: "fcm",
        endpoint: endpointKey,
        fcmToken,
        // p256dh + auth are NOT NULL in schema — provide sentinel values for FCM rows.
        p256dh: "fcm",
        auth: "fcm",
        deviceLabel: deviceLabel ?? null,
        expired: false,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logRouteError("push-notifications/fcm", error);
    return NextResponse.json(
      { code: "FCM_SUBSCRIBE_FAILED", message: "No se pudo registrar el token FCM." },
      { status: 500 },
    );
  }
}
