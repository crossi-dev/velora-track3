// Handler para DeterministicIntent kind="owner_only_blocked".
// Vive separado de dispatch.ts para no romper el límite de 300 líneas.
//
// Patrón: el dispatcher detectó deterministicamente un intent owner-only
// expresado por un empleado. En lugar de pasar al LLM (que alucinaba
// "Producto borrado del catálogo"), emitimos warm reject canónico +
// audit log + telemetría RBAC.

import { NextResponse } from "next/server";
import { cloudLog, logUnauthorizedAccess } from "@/lib/cloud-logger";
import { buildCompanionRefusal } from "../intent-permissions";
import type { OwnerOnlyBlockedIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

export function executeOwnerOnlyBlocked(
  intent: OwnerOnlyBlockedIntent,
  params: PreModelIntentParams,
): NextResponse {
  // Defense-in-depth: si por algún motivo se gatilló para owner, no
  // respondemos warm reject — devolvemos answer vacío y el flujo cae al
  // modelo. detect.ts ya gatea por actorRole, esto es un cinturón extra.
  if (params.actorRole === "owner") {
    return NextResponse.json({ answer: "" });
  }
  const refusal = buildCompanionRefusal(intent.blockedIntent);
  logUnauthorizedAccess({
    attemptedAction: intent.blockedIntent,
    actorRole: params.actorRole,
    endpoint: "/api/business-assistant [dispatcher owner-only gate]",
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId ?? undefined,
  });
  cloudLog({
    severity: "INFO",
    component: "RBAC",
    action: "ASSISTANT_RBAC_BLOCKED",
    a2a_transfer: false,
    message: `assistant.rbac blocked deterministically: ${intent.blockedIntent} for ${params.actorRole}`,
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId ?? undefined,
    data: { intent: intent.blockedIntent, role: params.actorRole, source: "deterministic" },
  });
  return NextResponse.json({ answer: refusal.answer });
}
