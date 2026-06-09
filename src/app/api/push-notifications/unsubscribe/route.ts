import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  checkRateLimit,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { z } from "zod";

const bodySchema = z.object({
  endpoint: z.string().min(1).max(2048),
});

// ── POST /api/push-notifications/unsubscribe ─────────────────────────────────
// Marks a push subscription as expired in the DB so the server stops
// delivering notifications to a device that has signed out.
// Called by handleSignOut before the browser-level sub.unsubscribe() call.
// Auth is required — only the authenticated session can revoke its own sub.

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const { businessId, actorUserId, actorEmployeeId, role } = ctx;
  // Scope the revocation to the authenticated actor only — prevents an employee
  // from revoking the owner's subscription by posting the owner's endpoint URL.
  const actorId = actorEmployeeId ?? actorUserId;

  let endpoint: string;
  try {
    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return badRequest("Endpoint inválido.");
    endpoint = parsed.data.endpoint;
  } catch {
    return badRequest("Cuerpo JSON inválido.");
  }

  try {
    await prisma.pushSubscription.updateMany({
      where: { businessId, userId: actorId, endpoint },
      data: { expired: true },
    });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "PUSH_UNSUBSCRIBED",
      a2a_transfer: false,
      message: "Push subscription revoked by actor",
      businessId,
      data: { actorRole: role, actorUserId, actorEmployeeId, endpointPrefix: endpoint.slice(0, 30) },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logRouteError("push-notifications/unsubscribe", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
