// Unified actor resolution para Velora.
//
// Un request puede venir de:
//   1. Owner via NextAuth/Google OAuth (cookie de sesión NextAuth)
//   2. Owner via native Bearer token (Capacitor Android)
//
// El concepto de "employee" (PIN-login, cookie HMAC velora-employee-session)
// fue removido — Employee tuvo 0 filas en producción. La pieza crítica: TODA
// mutación queda audit-eada con actorUserId del owner del business.
//
// CONVENCIÓN RBAC EN ENDPOINTS (audit 2026-04-28, actualizado post-employee-removal):
//   - Endpoint owner-only "natural": usa `auth()` directo (NextAuth) +
//     getBusinessIdForUser(). Ej: suppliers, customers, budgets,
//     purchase-requests, products/bulk-price-update.
//   - Endpoint via resolveActor(): retorna siempre role "owner" hoy. Si la
//     operación tiene mutaciones privilegiadas, seguir usando
//     `requireRole(ctx, ["owner"])` o assertRole() — el shape de ActorContext
//     se mantiene por compatibilidad (ver role-contract.ts).
//   - Endpoint público (sin auth): rate-limited only. Ej: /api/health.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  OWNER_NATIVE_HEADER,
  verifyOwnerNativeToken,
} from "@/lib/owner-native-auth-edge";
import { logUnauthorizedAccess, cloudLog } from "@/lib/cloud-logger";
import { ensureBusinessPlaceholder } from "@/auth";
import { isTesterEmail } from "@/lib/tester-allowlist";
import type { ActorRole, ActorContext } from "@/domain";

export type { ActorRole, ActorContext };

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

  // No hay sesión OAuth ni token nativo válido. El PIN-login employee path
  // fue removido (0 filas en producción) — no hay ningún otro auth path.
  return null;
}

/**
 * Verifica que el actor tenga rol permitido para una operación.
 * Lanza un Error si no — el caller debe convertirlo en 403.
 *
 * resolveActor() sólo retorna role "owner" hoy; el tipo Role sigue incluyendo
 * "employee" por compatibilidad (ver role-contract.ts, stage-2 cleanup).
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
