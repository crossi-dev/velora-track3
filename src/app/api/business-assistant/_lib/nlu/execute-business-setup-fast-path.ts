// Executor for the business_setup Fast Path. Mirrors the shape of
// executeCreateProduct / executeCobroQr — pure function over an already-
// detected intent + dispatcher params, returns a NextResponse.
//
// Pattern: no DB write, no LLM call. `language` and `currency` are client-
// side Settings toggles (localStorage `velora-lang`, cookie `NEXT_LOCALE`,
// currency formatter). We return a deterministic acknowledgement + a hint
// that points the owner at Settings → Idioma / Moneda. The supervisor used
// to handle this turn via Gemini Pro and the cross-region tail latency
// occasionally breached the route's 20s maxDuration.
//
// RBAC: owner-only. Empleados ya quedan rebotados upstream por el
// owner_only_blocked priority 0 si el detector matchea — pero por defensa
// en profundidad chequeamos role acá y devolvemos warm reject canónico.

import { NextResponse } from "next/server";
import { logUnauthorizedAccess } from "@/lib/cloud-logger";
import type { BusinessSetupFastPathIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

export function executeBusinessSetupFastPath(
  intent: BusinessSetupFastPathIntent,
  params: PreModelIntentParams,
): NextResponse {
  if (params.actorRole !== "owner") {
    logUnauthorizedAccess({
      attemptedAction: `business_setup_fast_path:${intent.field}`,
      actorRole: params.actorRole,
      endpoint: "/api/business-assistant [dispatcher business-setup-fp gate]",
      businessId: params.businessId,
      actorEmployeeId: params.actorEmployeeId ?? undefined,
    });
    return NextResponse.json({
      answer:
        "Eso lo cambia el dueño desde Ajustes. Avisale y en un toque queda.",
    });
  }

  if (intent.field === "language") {
    return NextResponse.json({
      answer:
        `Idioma cambiado a ${intent.label}. ` +
        `Tocá Ajustes → Idioma para fijar el toggle de la interfaz también (queda guardado en tu dispositivo).`,
      inputHint: "Ajustes → Idioma",
    });
  }

  // currency
  return NextResponse.json({
    answer:
      `Anotado, paso a mostrar los montos en ${intent.label}. ` +
      `Tocá Ajustes → Moneda para fijar el toggle a futuro.`,
    inputHint: "Ajustes → Moneda",
  });
}
