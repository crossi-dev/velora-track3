import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { normalizeForMatching } from "@/lib/normalize";
import {
  badRequest,
  checkRateLimit,
  internalError,
  jsonError,
  logRouteError,
  parseJsonBody,
} from "@/app/api/_lib/route-helpers";
import {
  EMPLOYEE_COOKIE_NAME,
  signEmployeeSession,
  verifyPin,
} from "@/lib/employee-auth";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  getRequestIp,
  checkIpThrottle,
  incrementIpThrottle,
  clearIpThrottle,
} from "./_lib/ip-throttle";

// Empleado se loguea con businessId + nombre + PIN.
//
// Tasa de error razonable: rate limit aplica per-IP con bucket dedicado
// "employee-login" (10 req/60s). Para PIN brute force, scrypt es
// deliberadamente lento, lo que da otro nivel de defensa.
//
// Exponential backoff (2026-05-09): cada vez que el contador de fallos
// alcanza el umbral (5) la cuenta se bloquea, y la duración del bloqueo
// crece con `consecutiveLockouts`:
//   1° lockout → 5m
//   2° lockout → 15m
//   3° lockout → 1h
//   4° lockout → 6h
//   5°+ lockout → 24h (cap)
// El contador `consecutiveLockouts` se resetea solo con un login exitoso
// (o con el unlock manual del dueño, que también limpia los counters).
//
// Per-IP+employee throttle (2026-05-12): additional in-memory layer keyed by
// ip:employeeId. 5 failures in 60s → HTTP 429 before the DB-backed per-employee
// lockout can be exhausted. Resets on successful login. Durable backstop is still
// the per-employee counter in Postgres.
// IP throttle helpers live in ./_lib/ip-throttle.ts.

// Dummy hash used to neutralise timing-based employee-name enumeration.
// When no employee row is found we still run verifyPin against this constant
// so the response time is indistinguishable from a real wrong-PIN attempt.
//
// To regenerate if scrypt params ever change:
//   node -e "const {scryptSync}=require('crypto');const s=Buffer.from('76656c6f72612d64756d6d792d73616c74','hex');const d=scryptSync('00000000',s,32,{N:16384,r:8,p:1});console.log('v1\$'+s.toString('hex')+'\$'+d.toString('hex'))"
const DUMMY_HASH_CONSTANT =
  "v1$76656c6f72612d64756d6d792d73616c74$2e152a313c444f644a3f7cd098e1f5ce3a7011e7faf70a94140294ecb1ddc2ab";

const LOCKOUT_THRESHOLD_ATTEMPTS = 5;
// Schedule en minutos. Se indexa por consecutiveLockouts (post-incremento):
// 1 → idx 0 (5m), 2 → idx 1 (15m), ..., 5+ → idx 4 (24h, cap).
const LOCKOUT_SCHEDULE_MINUTES = [5, 15, 60, 360, 1440] as const;

function lockoutDurationMs(consecutiveLockouts: number): number {
  const idx = Math.min(
    Math.max(consecutiveLockouts - 1, 0),
    LOCKOUT_SCHEDULE_MINUTES.length - 1,
  );
  return LOCKOUT_SCHEDULE_MINUTES[idx] * 60 * 1000;
}

interface LoginBody {
  businessId?: unknown;
  name?: unknown;
  pin?: unknown;
}

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, "employee-login", 10, 60);
  if (rateLimited) return rateLimited;

  const requestIp = getRequestIp(req);

  const parsed = await parseJsonBody<LoginBody>(req);
  if (!parsed.ok) return parsed.response;

  const businessId = typeof parsed.data.businessId === "string" ? parsed.data.businessId.trim() : "";
  const name = typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
  const pin = typeof parsed.data.pin === "string" ? parsed.data.pin.trim() : "";

  if (!businessId || !name || !pin) {
    return badRequest("Faltan businessId, nombre o PIN.");
  }

  // Accent-insensitive normalization: "Maria" matches "María".
  // Delegates to the canonical normalizeForMatching (NFKC→NFD→\p{M}→lowercase).
  const normalizeForMatch = normalizeForMatching;

  try {
    // Fetch all active employees for this business for accent-insensitive name match.
    // Businesses typically have <20 employees so this full scan is cheap.
    const [employeeCandidates, business] = await Promise.all([
      prisma.employee.findMany({
        where: { businessId, active: true },
        select: {
          id: true,
          name: true,
          businessId: true,
          pinHash: true,
          role: true,
          active: true,
          failedPinAttempts: true,
          lockedUntil: true,
          consecutiveLockouts: true,
          sessionVersion: true,
        },
      }),
      prisma.business.findUnique({
        where: { id: businessId },
        select: { sessionDurationHours: true, userId: true },
      }),
    ]);

    // Accent-insensitive name match: "Maria" matches "María", "jose" matches "José".
    const normalizedInput = normalizeForMatch(name);
    const employee = employeeCandidates.find(
      (e) => normalizeForMatch(e.name) === normalizedInput,
    ) ?? null;

    // Timing-safe: when no employee row exists we still run verifyPin against
    // DUMMY_HASH_CONSTANT so the response time is indistinguishable from a
    // real wrong-PIN attempt, closing the employee-name enumeration timing leak.
    if (!employee) {
      verifyPin(pin, DUMMY_HASH_CONSTANT); // result intentionally discarded
      return jsonError("INVALID_CREDENTIALS", "Invalid credentials.", 401);
    }

    // Per-IP+employee throttle — checked BEFORE the durable per-employee lockout
    // so a distributed attacker can't exhaust the 24h lockout from many IPs.
    if (checkIpThrottle(requestIp, employee.id)) {
      cloudLog({ severity: "WARNING", component: "System", action: "EMPLOYEE_LOGIN_IP_THROTTLED", a2a_transfer: false, message: "per-IP+employee login throttle triggered", businessId, data: { employeeId: employee.id, ip: requestIp } });
      return jsonError("TOO_MANY_ATTEMPTS", "Too many attempts. Try again later.", 429);
    }

    // Per-account lockout check.
    if (employee.lockedUntil && employee.lockedUntil > new Date()) {
      return jsonError("ACCOUNT_LOCKED", "Account locked. Contact your manager.", 429);
    }

    if (!verifyPin(pin, employee.pinHash)) {
      incrementIpThrottle(requestIp, employee.id);
      const newAttempts = employee.failedPinAttempts + 1;
      let lockData:
        | { failedPinAttempts: number }
        | { failedPinAttempts: number; lockedUntil: Date; consecutiveLockouts: number };
      if (newAttempts >= LOCKOUT_THRESHOLD_ATTEMPTS) {
        // Threshold hit — escalate to next lockout step. Reset attempt
        // counter so the next round starts fresh, but bump
        // consecutiveLockouts so the duration grows (and persists past
        // the active window — that's the whole point).
        const nextLockoutCount = employee.consecutiveLockouts + 1;
        lockData = {
          failedPinAttempts: 0,
          lockedUntil: new Date(Date.now() + lockoutDurationMs(nextLockoutCount)),
          consecutiveLockouts: nextLockoutCount,
        };
      } else {
        lockData = { failedPinAttempts: newAttempts };
      }
      try {
        await prisma.employee.update({ where: { id: employee.id }, data: lockData });
      } catch (err) {
        cloudLog({ severity: "ERROR", component: "System", action: "EMPLOYEE_LOCKOUT_UPDATE_FAILED", a2a_transfer: false, message: "failed attempt counter update failed — brute-force window open", businessId, data: { employeeId: employee.id, error: err instanceof Error ? err.message : String(err) } });
      }
      // Audit finding #10 — forensic visibility for failed PIN attempts.
      // Logs employeeId, IP, and UA to Cloud Logging for incident response.
      // PIN value is never logged.
      cloudLog({
        severity: "WARNING",
        component: "Auth",
        action: "EMPLOYEE_PIN_FAILED",
        a2a_transfer: false,
        message: "Failed PIN attempt",
        businessId,
        data: {
          employeeId: employee.id,
          ip: requestIp,
          ua: req.headers.get("user-agent") ?? null,
          attempt: newAttempts,
        },
      });
      return jsonError("INVALID_CREDENTIALS", "Invalid credentials.", 401);
    }

    // Successful login — clear IP throttle entry, reset lockout counters, and
    // increment sessionVersion (session fixation fix: pre-planted cookies with
    // the pre-login sv are invalidated on auth). The post-increment value is
    // read from the update result and embedded in the cookie, so subsequent
    // sv checks against the DB will match exactly.
    clearIpThrottle(requestIp, employee.id);
    let newSessionVersion = employee.sessionVersion + 1;
    try {
      const updated = await prisma.employee.update({
        where: { id: employee.id },
        data: {
          lastLoginAt: new Date(),
          failedPinAttempts: 0,
          lockedUntil: null,
          consecutiveLockouts: 0,
          sessionVersion: { increment: 1 },
        },
        select: { sessionVersion: true },
      });
      newSessionVersion = updated.sessionVersion;
    } catch (err) {
      cloudLog({ severity: "ERROR", component: "System", action: "EMPLOYEE_LOGIN_COUNTER_RESET_FAILED", a2a_transfer: false, message: "lockout counter reset failed — stale counters may remain", businessId, data: { employeeId: employee.id, error: err instanceof Error ? err.message : String(err) } });
    }

    const sessionDurationHours = Math.min(Math.max(1, business?.sessionDurationHours ?? 8), 24);
    const cookieValue = signEmployeeSession(
      {
        employeeId: employee.id,
        businessId: employee.businessId,
        role: employee.role,
        sv: newSessionVersion,
      },
      sessionDurationHours,
    );

    const response = NextResponse.json({
      ok: true,
      employee: {
        id: employee.id,
        name,
        role: employee.role,
        businessId: employee.businessId,
      },
    });

    response.cookies.set(EMPLOYEE_COOKIE_NAME, cookieValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict", // Fix 5: strict prevents CSRF on employee sessions
      path: "/",
      maxAge: sessionDurationHours * 60 * 60,
    });

    // Audit login — non-blocking: login must succeed even if DB is down.
    if (business?.userId) {
      recordCriticalWriteEvent({
        client: prisma,
        businessId: employee.businessId,
        actorUserId: business.userId,
        actorEmployeeId: employee.id,
        routeScope: "employees.login",
        actionType: "employee.login",
        resourceType: "Employee",
        resourceId: employee.id,
        summary: `Employee "${name}" logged in`,
        payload: { employeeId: employee.id, ip: req.headers.get("x-forwarded-for") ?? null },
      }).catch((err) => {
        cloudLog({ severity: "WARNING", component: "System", action: "EMPLOYEE_LOGIN_AUDIT_FAILED", a2a_transfer: false, message: "recordCriticalWriteEvent failed on employee login (non-critical)", businessId, data: { employeeId: employee.id, error: err instanceof Error ? err.message : String(err) } });
      });
    }

    return response;
  } catch (error) {
    logRouteError("employees.login", error);
    return internalError("No se pudo iniciar sesión.");
  }
}

// Logout — borra la cookie. No requiere validar sesión, idempotente.
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(EMPLOYEE_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Consistent with login POST above — strict prevents CSRF on session cookies.
    // Cookie-clear (maxAge: 0) must use the same attributes as the set, otherwise
    // some browsers treat it as a different cookie and the original is not cleared.
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
