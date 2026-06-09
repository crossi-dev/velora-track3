// Visibility filter — Brief Discovery v1 (2026-04-29), Gap 1.
//
// El Brief promete "un solo chat por negocio con filtro de visibilidad por
// mensaje". Cada `ChatMessage` clasifica su audiencia con `visibility`:
//   - "public"        — todos los miembros del business (default; back-compat).
//   - "owner_only"    — solo el dueño OAuth + agentes (companion / supervisor).
//                       Ej: análisis privados, decisiones autónomas del
//                       supervisor, consultas reflexivas que no llegan al
//                       empleado.
//   - "employee_only" — solo el empleado autor + companion (no el dueño).
//                       Privacy del empleado — dudas íntimas, pedidos de
//                       ayuda donde se sentiría expuesto si el dueño los ve.
//
// Este helper construye el `where` de Prisma para LEER mensajes según el
// actor del request. El caller compone el WHERE final con businessId,
// kind, etc. Ej:
//
//     const where: Prisma.ChatMessageWhereInput = {
//       businessId,
//       kind: { not: "chat_reset" },
//       ...chatMessageVisibilityFilter(actor),
//     };
//
// DECISIÓN (conservadora, ronda 2):
// - Owner ve `visibility IN ("public", "owner_only")`. NO ve `employee_only`
//   por privacy del empleado (Brief explícito + decisión SSE).
// - Employee ve `visibility IN ("public", "employee_only")` SIN filtrar por
//   author (`authorEmployeeId` no existe hoy). Si más adelante hay
//   multi-employee per-business, agregamos columna y filtramos por author
//   propio. Ver SSE-REVIEW abajo.
//
// Indexes covering: `@@index([businessId, visibility, createdAt])` cubre el
// query típico "lista mensajes visibles para X ordenados por fecha". El
// `IN ("a","b")` se evalúa eficientemente sobre ese índice.

import type { Prisma } from "@prisma/client";

export type VisibilityActorKind = "owner" | "employee";

/**
 * Construye el filtro WHERE de visibilidad para queries de lectura del chat.
 *
 * Devuelve un objeto parcial `Prisma.ChatMessageWhereInput` que el caller
 * mergea con el resto de su filtro (businessId, kind, etc.).
 *
 * Política:
 *   - owner    → `visibility IN ("public", "owner_only")` AND `customerId IS NULL`
 *   - employee → `visibility IN ("public", "employee_only")` AND `customerId IS NULL`
 *
 * `customerId IS NULL` excludes customer WhatsApp thread messages
 * (source="customer" / "customer_assistant", customerId set by the
 * velora-whatsapp-inbound worker). Those rows share visibility="public"
 * (default) with the owner/employee chat, so without this filter they leak
 * into the dashboard. Customer-thread loads (session-service.customer.ts)
 * query by `customerId: customer.id` directly and do NOT use this helper.
 *
 * SSE-REVIEW (multi-employee): cuando un business tenga >1 empleado activo,
 * el filtro `employee_only` debería restringir a los mensajes que el
 * empleado actual ESCRIBIÓ (privacy entre empleados). Hoy `ChatMessage` no
 * tiene `authorEmployeeId`. Decisión conservadora: por ahora el empleado
 * ve todos los `employee_only` de su business. Para 1 dueño + 1 empleado
 * (escenario demo) es equivalente. Pending: agregar columna +
 * filtrar `OR: [{ visibility: "public" }, { visibility: "employee_only", authorEmployeeId: X }]`.
 */
export function chatMessageVisibilityFilter(
  actor: { kind: VisibilityActorKind; employeeId?: string },
): Prisma.ChatMessageWhereInput {
  if (actor.kind === "owner") {
    // customerId: null excludes customer WhatsApp thread messages that share
    // visibility="public" with owner/employee chat rows.
    return { visibility: { in: ["public", "owner_only"] }, customerId: null } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Prisma client regen blocked on Windows DLL lock; Cloud Build runs prisma generate fresh so prod runtime has ChatMessage.customerId.
  }
  // Employee sees public/employee_only messages with no target OR targeted to them.
  // customerId: null ensures customer WhatsApp threads don't appear in companion chat.
  return {
    AND: [
      { visibility: { in: ["public", "employee_only"] } },
      { OR: [{ targetEmployeeId: null }, { targetEmployeeId: actor.employeeId }] },
      { customerId: null },
    ],
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- same Prisma regen caveat; customerId exists in schema, not yet in local generated client.
}

/**
 * Lista de visibilities permitidas para owner. Útil para validaciones
 * downstream o building queries en otros contextos (ej: tests).
 */
export const OWNER_VISIBLE: ReadonlyArray<string> = ["public", "owner_only"];

/**
 * Lista de visibilities permitidas para employee. Útil para validaciones
 * downstream o building queries en otros contextos (ej: tests).
 */
export const EMPLOYEE_VISIBLE: ReadonlyArray<string> = ["public", "employee_only"];
