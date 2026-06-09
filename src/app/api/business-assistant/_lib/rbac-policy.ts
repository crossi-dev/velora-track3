// RBAC policy — capa pura para gating de intents destructivos del empleado.
//
// La lista canónica de intents permitidos al empleado vive en
// `@/domain/role-contract` (EMPLOYEE_ALLOWED_INTENTS / canRoleExecuteIntent).
// Este archivo expone guards reutilizables sin side-effects (sin Prisma,
// sin NextResponse, sin loggers), pero TODA decisión de autorización delega
// al contrato canónico para que no pueda divergir.
//
// Antes de 2026-05-09 EMPLOYEE_DESTRUCTIVE_INTENTS se definía localmente y
// excluía `edit_customer` (y `create_customer`) por una nota antigua sobre el
// "flujo de venta". Esa lista contradecía OWNER_ONLY_INTENTS y permitía que
// `rbacGuard` (la API pública pensada como "guard reutilizable") aprobara a
// un empleado para edit_customer mientras `gateIntentByRole` (canon, vía
// role-contract) lo bloqueaba. La auditoría 2026-05-09 marcó esa
// inconsistencia: defense-in-depth solo funciona si todas las capas coinciden,
// sino una capa nueva confiando en `rbacGuard` filtraría el rol.

import { canRoleExecuteIntent, OWNER_ONLY_INTENTS } from "@/domain/role-contract";

/**
 * Intents que los empleados NO pueden ejecutar directamente.
 * Re-export del contrato canónico (`OWNER_ONLY_INTENTS`) para callers que
 * históricamente importaban este símbolo. NO redefinir acá.
 */
export const EMPLOYEE_DESTRUCTIVE_INTENTS: ReadonlySet<string> = OWNER_ONLY_INTENTS;

export function canEmployeeExecuteIntent(intent: string): boolean {
  return canRoleExecuteIntent("employee", intent);
}

export type RbacActorKind = "employee" | "owner";

export interface RbacGuardResult {
  allowed: boolean;
  reason?: string;
}

export function rbacGuard(
  actor: { kind: RbacActorKind },
  intent: string,
): RbacGuardResult {
  if (canRoleExecuteIntent(actor.kind, intent)) return { allowed: true };
  return {
    allowed: false,
    reason: `Esa acción la tiene que hacer el dueño. Avisale por chat o esperá a que esté disponible.`,
  };
}
