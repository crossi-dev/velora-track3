import { type NextRequest, NextResponse } from "next/server";
import { badRequest, bypassIfTester, checkRateLimit, unauthorized } from "@/app/api/_lib/route-helpers";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor?.actorEmployeeId) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(actor));
  if (rateLimited) return rateLimited;

  const body = await req.json() as { messageId?: unknown };
  // Validate messageId format before querying: must be a string in the cuid/UUID
  // length range (10–50 chars). Malformed values would otherwise cause an
  // unhandled 500 from Prisma.
  if (
    typeof body.messageId !== "string" ||
    body.messageId.length < 10 ||
    body.messageId.length > 50
  ) {
    return badRequest("messageId inválido.");
  }

  await prisma.chatMessage.updateMany({
    where: { id: body.messageId, businessId: actor.businessId, targetEmployeeId: actor.actorEmployeeId, ackedAt: null },
    data: { ackedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
