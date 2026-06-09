// Builders for the fiscal-setup mini-flow (FS1-FS3).
// Pure — no context reads, no DB writes.
// Mirrors the FastPathResult shape from onboarding-fast-path.builders.ts.

import type { ChipsBundle } from "@/app/api/supervisor/_lib/supervisor-chips";
import type { SupervisorAction } from "@/app/api/supervisor/_lib/business-rule-actions";
import type { IvaCondition } from "./onboarding-fast-path.fiscal-setup";
import { FS2_DEFER_CHIP } from "./onboarding-fast-path.chips";

export interface FiscalSetupResult {
  /** Text the client will display. */
  answer: string;
  /** update_business_setup actions to persist the captured data. */
  actions: SupervisorAction[];
  /** Chips for the next step (FS2 has IVA-condition chips). */
  chips: ChipsBundle | null;
  /**
   * Which step was resolved:
   *   "prompt" = gate message (FS0), no data captured yet
   *   "error"  = validation error (CUIT invalid), no data captured
   *   1 = CUIT captured
   *   2 = IVA condition captured
   *   3 = punto de venta captured (or deferred)
   */
  matchedStep: "prompt" | "error" | 1 | 2 | 3;
}

// ── Chips ─────────────────────────────────────────────────────────────────────

const IVA_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Monotributista", value: "Monotributista" },
    { label: "Responsable Inscripto", value: "Responsable Inscripto" },
    { label: "Exento", value: "Exento" },
  ],
};

// ── FS0: gate prompt ──────────────────────────────────────────────────────────

/** Gate message: shown when invoice intent detected but no CUIT on file. */
export function buildFSPrompt(): FiscalSetupResult {
  return {
    answer:
      "Para emitir comprobantes necesito algunos datos fiscales. " +
      "¿Cuál es el CUIT del negocio? (11 dígitos, ej: 30-71234567-1)",
    actions: [],
    chips: null,
    matchedStep: "prompt",
  };
}

// ── FS1: CUIT ────────────────────────────────────────────────────────────────

/** CUIT validated and captured — advance to IVA condition. */
export function buildFS1Result(cuit: string): FiscalSetupResult {
  return {
    answer: `CUIT ${cuit} validado. ¿Cuál es la condición frente al IVA?`,
    actions: [
      {
        intent: "update_business_setup",
        data: { field: "cuit", value: cuit },
        summary: "CUIT del negocio guardado",
      },
    ],
    chips: IVA_CHIPS,
    matchedStep: 1,
  };
}

/** CUIT input was present but failed the AFIP check-digit algorithm. */
export function buildFS1ValidationError(errorMsg: string): FiscalSetupResult {
  return {
    answer: `Ese CUIT no es válido: ${errorMsg} Revisá los dígitos e intentá de nuevo.`,
    actions: [],
    chips: null,
    matchedStep: "error",
  };
}

// ── FS2: IVA condition ────────────────────────────────────────────────────────

/** IVA condition captured — advance to punto de venta. */
export function buildFS2Result(iva: IvaCondition): FiscalSetupResult {
  return {
    answer:
      `${iva} anotado. ¿Cuál es el número de punto de venta? ` +
      "(1-4 dígitos, ej: 1 — o tocá \"Más tarde\" para configurarlo después)",
    actions: [
      {
        intent: "update_business_setup",
        data: { field: "ivaCondition", value: iva },
        summary: "Condición IVA guardada",
      },
    ],
    chips: FS2_DEFER_CHIP,
    matchedStep: 2,
  };
}

// ── FS3: punto de venta ───────────────────────────────────────────────────────

/** Punto de venta number captured — flow complete. */
export function buildFS3Result(puntoVenta: string): FiscalSetupResult {
  return {
    answer:
      `Punto de venta ${puntoVenta} guardado. ` +
      "Ya podés emitir comprobantes. Decime la operación que necesitás facturar.",
    actions: [
      {
        intent: "update_business_setup",
        data: { field: "puntoVenta", value: puntoVenta },
        summary: "Punto de venta guardado",
      },
    ],
    chips: null,
    matchedStep: 3,
  };
}

/** Owner deferred punto de venta — flow ends with a reminder. */
export function buildFS3DeferResult(): FiscalSetupResult {
  return {
    answer:
      "Ok, lo configurás desde Ajustes → Fiscal cuando quieras. " +
      "Con CUIT y condición IVA ya podés emitir comprobantes tipo C en modo sandbox.",
    actions: [
      {
        intent: "update_business_setup",
        data: { field: "puntoVenta", value: "0" },
        summary: "Punto de venta diferido (sentinel 0)",
      },
    ],
    chips: null,
    matchedStep: 3,
  };
}
