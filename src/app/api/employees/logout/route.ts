import { NextRequest, NextResponse } from "next/server";
import { EMPLOYEE_COOKIE_NAME, verifyEmployeeSession, invalidateEmployeeSessions } from "@/lib/employee-auth";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

export async function POST(req: NextRequest) {
  // NOTE: tester bypass is not applied here — logout uses verifyEmployeeSession
  // directly (no resolveActor), so no actor.isTester is available. The 120/min
  // default is generous enough that testers won't hit it in practice.
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  // Audit logout before clearing the cookie. Best-effort: never block the
  // response if the DB write fails. If the cookie is missing or already expired
  // there is nothing to audit (the session was already gone).
  const cookieValue = req.cookies.get(EMPLOYEE_COOKIE_NAME)?.value ?? null;
  const session = verifyEmployeeSession(cookieValue);
  if (session) {
    prisma.business
      .findUnique({ where: { id: session.businessId }, select: { userId: true } })
      .then((business) => {
        if (!business?.userId) return;
        return recordCriticalWriteEvent({
          client: prisma,
          businessId: session.businessId,
          actorUserId: business.userId,
          actorEmployeeId: session.employeeId,
          routeScope: "employees.logout",
          actionType: "employee.logout",
          resourceType: "Employee",
          resourceId: session.employeeId,
          summary: `Employee logged out`,
          payload: { employeeId: session.employeeId },
        });
      })
      .catch((err) => {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "EMPLOYEE_LOGOUT_AUDIT_FAILED",
          a2a_transfer: false,
          message: "recordCriticalWriteEvent failed on employee logout (non-critical)",
          businessId: session.businessId,
          data: { employeeId: session.employeeId, error: err instanceof Error ? err.message : String(err) },
        });
      });
  }

  // Invalidate the session server-side BEFORE clearing the cookie so any
  // other open tab or device holding the same cookie is also rejected on the
  // next request. OWASP: server-side invalidation is the critical action;
  // clearing the cookie alone only protects the current browser tab.
  // https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
  if (session) {
    await invalidateEmployeeSessions(session.employeeId).catch((err) => {
      cloudLog({
        severity: "WARNING",
        component: "Auth",
        action: "EMPLOYEE_LOGOUT_INVALIDATE_FAILED",
        a2a_transfer: false,
        message: "invalidateEmployeeSessions failed on logout — cookie cleared but sv not bumped",
        businessId: session.businessId,
        data: { employeeId: session.employeeId, error: err instanceof Error ? err.message : String(err) },
      });
    });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(EMPLOYEE_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Consistent with login POST — strict prevents CSRF on session cookies.
    // Cookie-clear (maxAge: 0) must match the attributes used at set time;
    // mismatched SameSite can cause browsers to skip the clear entirely.
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
