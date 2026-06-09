import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  bypassIfTester,
  checkRateLimit,
  internalError,
  logRouteError,
  notFound,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";

// Owner-only: unlock an employee account locked by failed PIN attempts.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ employeeId: string }> },
) {
  const actor = await resolveActor(req);
  if (!actor) return unauthorized();

  const roleError = requireRole(actor, ["owner"]);
  if (roleError) return roleError;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(actor));
  if (rateLimited) return rateLimited;

  const { employeeId } = await params;

  try {
    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, businessId: actor.businessId },
      select: { id: true, name: true },
    });
    if (!employee) return notFound("Employee not found.");

    // Owner override also clears consecutiveLockouts — the owner is
    // explicitly vouching for the holder, so the exponential backoff
    // counter resets to step 1 for any future failed attempts.
    await prisma.employee.update({
      where: { id: employee.id },
      data: { failedPinAttempts: 0, lockedUntil: null, consecutiveLockouts: 0 },
    });

    await recordCriticalWriteEvent({
      client: prisma,
      businessId: actor.businessId,
      actorUserId: actor.actorUserId,
      routeScope: "employees.unlock",
      actionType: "employee.unlock",
      resourceType: "Employee",
      resourceId: employee.id,
      summary: `Unlocked employee "${employee.name}"`,
      payload: { employeeId: employee.id, name: employee.name },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    logRouteError("employees.unlock", error);
    return internalError("Could not unlock employee.");
  }
}
