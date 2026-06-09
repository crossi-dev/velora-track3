// Unified actor resolution para Velora.
//
// Hoy un request puede venir de:
//   1. Owner via NextAuth/Google OAuth (cookie de sesión NextAuth)
//   2. Employee via PIN auth (cookie firmada HMAC velora-employee-session)
//
// resolveActor() unifica ambos paths y retorna context consistente para
// que las routes no tengan que conocer el detalle de auth. La pieza
// crítica: TODA mutación queda audit-eada con actorUserId del owner del
// business (siempre presente) + actorEmployeeId opcional cuando el actor
// es empleado.
//
// CONVENCIÓN RBAC EN ENDPOINTS (audit 2026-04-28):
//   - Endpoint owner-only "natural": usa `auth()` directo (NextAuth) +
//     getBusinessIdForUser(). Empleados no tienen sesión NextAuth, así
//     que rebotan en `auth() === null`. Ej: suppliers, customers, budgets,
//     purchase-requests, products/bulk-price-update.
//   - Endpoint mixto (owner + empleado): usa `resolveActor()` para aceptar
//     ambos auth paths. Si la operación tiene mutaciones privilegiadas,
//     SIEMPRE seguir con `requireRole(ctx, ["owner"])` o assertRole().
//     Ej: products POST/PATCH/DELETE, stock-loads, cash-movements.
//   - Endpoint público (sin auth): rate-limited only. Ej: /api/health.
//
// Si refactorizás un endpoint owner-only "natural" para aceptar empleados
// vía resolveActor(), agregá requireRole() en el mismo commit. Si no, la
// audit del rol queda invisible y un cookie viejo puede pasar.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  EMPLOYEE_COOKIE_NAME,
  verifyEmployeeSession,
} from "@/lib/employee-auth-edge";
import {
  OWNER_NATIVE_HEADER,
  verifyOwnerNativeToken,
} from "@/lib/owner-native-auth-edge";
import { logUnauthorizedAccess, cloudLog } from "@/lib/cloud-logger";
import { ensureBusinessPlaceholder } from "@/auth";
import { isTesterEmail } from "@/lib/tester-allowlist";
import type { ActorRole, ActorContext } from "@/domain";

export type { ActorRole, ActorContext };

// ── Employee session-version cache ────────────────────────────────────────────
// Mirrors the owner path in auth-session-version.ts. 5s TTL: fast enough to
// make revocation effective within one shift; cheap enough to cut N DB round-
// trips per second under load. Cloud Run multi-instance staleness is the same
// accepted trade-off as the owner cache.
// Key: employeeId → { sessionVersion, active, businessId, cachedAt }

const EMP_CACHE_TTL_MS = 5_000;

interface EmpCacheEntry {
  sessionVersion: number;
  active: boolean;
  businessId: string;
  cachedAt: number;
}

const empSessionCache = new Map<string, EmpCacheEntry>();

function empCacheGet(employeeId: string): EmpCacheEntry | undefined {
  const entry = empSessionCache.get(employeeId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > EMP_CACHE_TTL_MS) {
    empSessionCache.delete(employeeId);
    return undefined;
  }
  return entry;
}

function empCacheSet(employeeId: string, data: Omit<EmpCacheEntry, "cachedAt">): void {
  empSessionCache.set(employeeId, { ...data, cachedAt: Date.now() });
}

/** Exported for invalidateEmployeeSessions() to evict on revocation. */
export function evictEmployeeSessionCache(employeeId: string): void {
  empSessionCache.delete(employeeId);
}

// Exported for unit tests only — do not use in production code.
export const _testOnly = { empSessionCache, empCacheGet };

/**
 * Resuelve el actor del request, unificando OAuth + PIN auth.
 * Retorna null si no hay sesión válida (ninguna de las dos).
 *
 * Orden de prioridad:
 *   1. NextAuth session cookie (owner OAuth) — siempre gana si está presente.
 *   2. Owner native HMAC token header (Capacitor Android).
 *   3. Employee cookie firmada (PIN auth).
 *
 * M4 (security invariant): OAuth beats native intentionally. Both require the
 * same AUTH_SECRET-derived key, so a compromised-device attacker who can forge
 * an OAuth cookie already owns the secret. The priority is documented here so
 * future readers don't invert it thinking native should bypass OAuth.
 */
export async function resolveActor(req: NextRequest): Promise<ActorContext | null> {
  // 1. OAuth path (owner)
  const session = await auth();
  if (session?.user?.id) {
    const business = await prisma.business.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!business) {
      // Lazy recovery: Business placeholder may have failed silently on first
      // OAuth login (Neon timeout, network blip). Attempt to create it now and
      // retry once before giving up.
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "OWNER_BUSINESS_PLACEHOLDER_LAZY_RECOVERY",
        a2a_transfer: false,
        message: "Business row missing for authenticated owner — attempting lazy recovery",
        businessId: "",
        data: { userId: session.user.id },
      });
      await ensureBusinessPlaceholder(session.user.id);
      const retried = await prisma.business.findUnique({
        where: { userId: session.user.id },
        select: { id: true },
      });
      if (!retried) return null;
      return {
        businessId: retried.id,
        actorUserId: session.user.id,
        actorEmployeeId: null,
        role: "owner",
        isTester: isTesterEmail(session.user.email),
      };
    }
    return {
      businessId: business.id,
      actorUserId: session.user.id,
      actorEmployeeId: null,
      role: "owner",
      isTester: isTesterEmail(session.user.email),
    };
  }

  // 2. Owner via native Bearer token (Capacitor Android)
  const nativeToken = req.headers.get(OWNER_NATIVE_HEADER);
  const nativeResult = await verifyOwnerNativeToken(nativeToken);
  if (nativeResult) {
    const business = await prisma.business.findUnique({
      where: { userId: nativeResult.payload.userId },
      select: { id: true },
    });
    if (!business) {
      // Lazy recovery: Business placeholder may have failed silently on first
      // native login (Neon timeout, network blip). Mirror the OAuth path —
      // attempt to create it now and retry once before giving up.
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "OWNER_NATIVE_BUSINESS_PLACEHOLDER_LAZY_RECOVERY",
        a2a_transfer: false,
        message: "Business row missing for native owner — attempting lazy recovery",
        businessId: "",
        data: { userId: nativeResult.payload.userId },
      });
      await ensureBusinessPlaceholder(nativeResult.payload.userId);
      const retried = await prisma.business.findUnique({
        where: { userId: nativeResult.payload.userId },
        select: { id: true },
      });
      if (!retried) return null;
      return {
        businessId: retried.id,
        actorUserId: nativeResult.payload.userId,
        actorEmployeeId: null,
        role: "owner" as ActorRole,
        isTester: isTesterEmail(nativeResult.payload.email),
      };
    }
    return {
      businessId: business.id,
      actorUserId: nativeResult.payload.userId,
      actorEmployeeId: null,
      role: "owner" as ActorRole,
      isTester: isTesterEmail(nativeResult.payload.email),
    };
  }

  // 3. PIN path (employee)
  const employeeCookie = req.cookies.get(EMPLOYEE_COOKIE_NAME)?.value ?? null;
  const verified = await verifyEmployeeSession(employeeCookie);
  if (!verified) return null;
  const { payload: empSession } = verified;

  // Re-validate employee still exists and is active on every request.
  // Cookie signature/expiry alone is not sufficient — the employee may have
  // been deleted, deactivated, or force-logged-out since the cookie was issued.
  // sessionVersion check closes the session-revocation gap: stolen/leaked cookies
  // are rejected immediately after the owner calls invalidateEmployeeSessions().
  // OWASP Session Management Cheat Sheet: server-side invalidation is the
  // critical action; client-side cookie clearing alone is insufficient.
  // https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
  //
  // 5s in-memory cache (EMP_CACHE_TTL_MS) mirrors the owner path in
  // auth-session-version.ts. On revocation, all Cloud Run instances see the
  // new sessionVersion within 5s (cache TTL). The revoking instance can call
  // evictEmployeeSessionCache(employeeId) after invalidateEmployeeSessions()
  // for immediate local eviction (same pattern as auth-session-version.ts).
  // Accepted trade-off: 5s max staleness window on non-evicting instances.
  let empData: Omit<EmpCacheEntry, "cachedAt"> | undefined = empCacheGet(empSession.employeeId);
  if (!empData) {
    const row = await prisma.employee.findUnique({
      where: { id: empSession.employeeId },
      select: { active: true, businessId: true, sessionVersion: true },
    });
    if (!row) return null;
    empData = { sessionVersion: row.sessionVersion, active: row.active, businessId: row.businessId };
    empCacheSet(empSession.employeeId, empData);
  }
  const emp = empData;
  if (!emp.active || emp.businessId !== empSession.businessId) return null;

  // Session version check — rejects cookies issued before the last
  // invalidateEmployeeSessions() call (force-logout, PIN reset, revocation).
  // Analogous to RFC 7519 §4.1.4 exp semantics applied to a version counter:
  // https://datatracker.ietf.org/doc/html/rfc7519
  if (emp.sessionVersion !== empSession.sv) {
    cloudLog({
      severity: "WARNING",
      component: "Auth",
      action: "EMPLOYEE_SESSION_VERSION_MISMATCH",
      a2a_transfer: false,
      message: "Employee cookie rejected — sessionVersion mismatch (post-revocation or forged)",
      data: { employeeId: empSession.employeeId, cookieSv: empSession.sv, dbSv: emp.sessionVersion },
      businessId: emp.businessId,
    });
    return null;
  }

  // Owner del business — requerido por audit aunque el actor sea empleado.
  // Single query, indexed by Business.id PK.
  const business = await prisma.business.findUnique({
    where: { id: empSession.businessId },
    select: { userId: true },
  });
  if (!business?.userId) return null;

  const role: ActorRole = "employee";

  return {
    businessId: empSession.businessId,
    actorUserId: business.userId,
    actorEmployeeId: empSession.employeeId,
    role,
    isTester: false,
  };
}

/**
 * Verifica que el actor tenga rol permitido para una operación.
 * Lanza un Error si no — el caller debe convertirlo en 403.
 *
 * Roles allowed:
 *   - "employee": ventas, queries, customer ops
 *   - "owner": all (incluyendo precios, stock load, cash movements, suppliers)
 */
export function assertRole(actor: ActorContext, allowed: ActorRole[]): void {
  if (!allowed.includes(actor.role)) {
    const err = new Error(`FORBIDDEN_ROLE:${actor.role}:${allowed.join(",")}`);
    err.name = "ForbiddenRoleError";
    throw err;
  }
}

/**
 * Variante non-throwing de assertRole para rutas que prefieren control de
 * flujo lineal (sin try/catch). Retorna 403 NextResponse si el role no
 * está en la allowlist, null si pasó. Pensado para gatear en el tope del
 * handler antes de cualquier mutación o reserva idempotente.
 *
 * El response body es genérico — no exponemos el role del usuario ni el
 * allowlist, para no facilitar enumeration. El endpoint devolvió 403 y
 * listo: el cliente legítimo no debería pegar acá nunca.
 */
export function requireRole(actor: ActorContext, allowed: ActorRole[]): NextResponse | null {
  if (allowed.includes(actor.role)) return null;
  // Cloud Logging audit point — endpoint-level RBAC rejection. Buscable
  // como `action="UNAUTHORIZED_ACCESS"` con el rol que intentó.
  logUnauthorizedAccess({
    attemptedAction: `role-gated:${allowed.join("|")}`,
    actorRole: actor.role,
    businessId: actor.businessId,
    actorEmployeeId: actor.actorEmployeeId ?? undefined,
  });
  return NextResponse.json(
    { code: "FORBIDDEN", message: "Insufficient permissions." },
    { status: 403 },
  );
}
