// RBAC layer del agente Empleado — gating de intents según rol del actor.
//
// Defense-in-depth: los endpoints downstream también deben gatear con
// assertRole (resolve-actor.ts). Esto es la primera línea — no la única.
//
// La lista canónica de intents bloqueados vive en `role-contract.ts`.
// Este archivo importa desde ahí — nunca redefine la lista.

import { NextResponse } from "next/server";
import type { ActorRole } from "@/app/api/_lib/resolve-actor";
import { cloudLog, logUnauthorizedAccess } from "@/lib/cloud-logger";
import type { AssistantIntent } from "./types";
import { canRoleExecuteIntent } from "./role-contract";

export function isIntentAllowedForRole(
  role: ActorRole,
  intent: AssistantIntent | "answer",
): boolean {
  return canRoleExecuteIntent(role, intent);
}

export interface EmployeeRefusal {
  answer: string;
  inputHint?: string;
  forbiddenIntent: AssistantIntent;
}

/**
 * Construye respuesta cálida para cuando un empleado pide algo que sólo
 * puede hacer el dueño. Tono = compañero de turno (warm, no condescending).
 *
 * El mensaje propone la acción concreta: "avisale al dueño" o "el dueño
 * lo carga desde su panel". Evita lenguaje burocrático ("permiso denegado",
 * "no autorizado") que rompe la sensación del demo.
 */
export function buildEmployeeRefusal(intent: AssistantIntent): EmployeeRefusal {
  switch (intent) {
    case "edit_product":
    case "bulk_price_update":
      return {
        answer:
          "Los precios son fijos — eso lo decide el dueño. Si el cliente insiste o hay un error en el precio, anotalo y se lo paso al dueño al cierre.",
        forbiddenIntent: intent,
      };
    case "delete_product":
      return {
        answer:
          "Borrar productos lo hace el dueño. Si querés que lo saque del catálogo, avisale.",
        forbiddenIntent: intent,
      };
    case "adjust_stock":
      return {
        answer:
          "Los ajustes de stock los hace el dueño. Si contaste y no cuadra, avisale con el número.",
        forbiddenIntent: intent,
      };
    case "register_movement":
      return {
        answer:
          "Los movimientos de caja los registra el dueño. Anotalo en una nota y pasáselo al cierre.",
        forbiddenIntent: intent,
      };
    case "edit_customer":
      return {
        answer:
          "Los datos de clientes los edita el dueño. Si hay algo para corregir, avisale con el detalle.",
        forbiddenIntent: intent,
      };
    case "delete_customer":
      return {
        answer:
          "Borrar clientes lo hace el dueño. Si creés que hay un cliente para sacar, avisale el nombre.",
        forbiddenIntent: intent,
      };
    case "create_customer":
      return {
        answer:
          "Los clientes los carga el dueño. Si hay un cliente nuevo, pasale los datos y él lo registra.",
        forbiddenIntent: intent,
      };
    case "create_purchase_request":
      return {
        answer:
          "Los pedidos a proveedores los gestiona el dueño. Avisale qué falta y él hace el pedido.",
        forbiddenIntent: intent,
      };
    case "create_supplier":
    case "edit_supplier":
    case "delete_supplier":
      return {
        answer:
          "Los proveedores los maneja el dueño. Si llegó alguien nuevo, pasale el contacto.",
        forbiddenIntent: intent,
      };
    case "create_product":
      return {
        answer:
          "Los productos los carga el dueño. Anotá el nombre y precio y pasáselo para que lo sume al catálogo.",
        forbiddenIntent: intent,
      };
    case "create_budget":
      return {
        answer:
          "Los presupuestos los genera el dueño desde su panel. Avisale qué necesita el cliente.",
        forbiddenIntent: intent,
      };
    case "return_sale":
      return {
        answer:
          "Las devoluciones solo las autoriza el dueño. Anotá el producto, cantidad y motivo — se lo paso al dueño al cierre para que lo registre.",
        forbiddenIntent: intent,
      };
    default:
      return {
        answer:
          "Esa acción la decide el dueño. Si querés que lo evalúe, anotá el motivo y se lo paso al cierre.",
        forbiddenIntent: intent,
      };
  }
}

/**
 * Gate de alto nivel — chequea si el actor tiene permiso para el intent
 * resuelto. Si no, retorna un NextResponse 200 con la respuesta cálida del
 * Empleado. Si pasa, retorna null y el caller continua al dispatch.
 *
 * Logea en nivel info (no warning) — los rebotes RBAC son normales
 * en operación; un empleado preguntándole al chat por un cambio de precio
 * es esperable, no es un incidente de seguridad.
 */
interface RbacGateOptions {
  intent: AssistantIntent | "answer";
  role: ActorRole;
  businessId: string;
  actorEmployeeId?: string | null;
  trace: { add: (step: string, detail: string) => void; toJSON: () => Record<string, unknown> | null };
}

export function gateIntentByRole(opts: RbacGateOptions): NextResponse | null {
  if (opts.intent === "answer") return null;
  if (isIntentAllowedForRole(opts.role, opts.intent)) return null;
  const refusal = buildEmployeeRefusal(opts.intent as AssistantIntent);
  opts.trace.add("rbac", `blocked intent=${opts.intent} role=${opts.role}`);
  cloudLog({
    severity: "INFO",
    component: "RBAC",
    action: "ASSISTANT_RBAC_BLOCKED",
    a2a_transfer: false,
    message: `assistant.rbac blocked: ${opts.intent} for ${opts.role}`,
    businessId: opts.businessId,
    actorEmployeeId: opts.actorEmployeeId ?? undefined,
    data: { intent: opts.intent, role: opts.role },
  });
  // Cloud Logging audit — buscable como `action="UNAUTHORIZED_ACCESS"`.
  logUnauthorizedAccess({
    attemptedAction: opts.intent,
    actorRole: opts.role,
    endpoint: "/api/business-assistant [chat layer]",
    businessId: opts.businessId,
    actorEmployeeId: opts.actorEmployeeId ?? undefined,
  });
  return NextResponse.json({ answer: refusal.answer, ...opts.trace.toJSON() });
}
