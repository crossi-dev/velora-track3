// Builders for T12 (customers), T13 (ARCA), and T14 (Andreani) onboarding turns.
// Split from onboarding-fast-path.builders.ts to keep that file under 300 LOC.
// All builders are pure — no context reads, no DB writes.

import { T_CUSTOMERS_CHIPS, T_ARCA_CHIPS, buildCourierConnectChips } from "./onboarding-fast-path.chips";

const COURIER_DISPLAY: Record<string, string> = {
  andreani: "Andreani",
  oca: "OCA",
  correo: "Correo Argentino",
};
function courierDisplayName(courierPreference: string | null): string {
  const key = (courierPreference ?? "").trim().toLowerCase();
  return COURIER_DISPLAY[key] ?? "tu courier";
}
function courierSettingsPanel(courierPreference: string | null): string {
  const key = (courierPreference ?? "").trim().toLowerCase();
  if (key === "oca") return "logistica.oca";
  if (key === "correo") return "logistica.correo";
  return "logistica.andreani";
}
import type { FastPathResult } from "./onboarding-fast-path.builders";
import type { TCustomersChoice, ParsedCustomerInput } from "./onboarding-fast-path.parsers.t-customers";
import type { ConnectChoice } from "./onboarding-fast-path.parsers.t-connect";

// ── T12: carga de clientes ─────────────────────────────────────────────────

export function buildTCustomersResult(choice: TCustomersChoice): FastPathResult {
  if (choice === "foto") {
    return {
      answer: "Dale, sacale una foto a la lista de clientes del cuaderno. Te abro la cámara.",
      actions: [{
        intent: "open_photo_picker",
        data: {},
        summary: "Abrir cámara para foto de lista de clientes",
      }],
      chips: null,
      clientAction: "open_photo_picker",
      clientActionParams: { context: "customers" },
      matchedTurn: 12,
    };
  }
  if (choice === "manual") {
    return {
      answer: "Dale, escribí el primer cliente: nombre y WhatsApp (opcional). Ej: \"María López 1112345678\".\nSi tenés varios, pegá uno por línea.",
      actions: [],
      chips: null,
      matchedTurn: 12,
    };
  }
  if (choice === "archivo") {
    return {
      answer: "Dale, tirá tu Excel o CSV de clientes acá.",
      actions: [],
      chips: null,
      clientAction: "open_file_picker",
      matchedTurn: 12,
    };
  }
  // saltar — persist the flag so the turn does NOT re-fire next message.
  return {
    answer: "Ok, los cargás cuando vendas.",
    actions: [{
      intent: "update_business_setup",
      data: { field: "customersOnboardingSkipped", value: true },
      summary: "Carga de clientes diferida por el dueño",
    }],
    chips: null,
    matchedTurn: 12,
  };
}

/** Creates N customers from inline typed text (single or bulk). */
export function buildTCustomersInlineResult(
  customers: ParsedCustomerInput[],
  skipped: number,
): FastPathResult {
  const plural = customers.length === 1 ? "cliente" : "clientes";
  const skipNote =
    skipped > 0
      ? ` (${skipped} ${skipped === 1 ? "línea no reconocida, la salté" : "líneas no reconocidas, las salté"})`
      : "";
  return {
    answer: `Listo, cargué ${customers.length} ${plural}.${skipNote} ¿Seguimos con el próximo paso?`,
    actions: [{
      intent: "create_customers_bulk_onboarding",
      data: { customers },
      summary: `${customers.length} clientes del onboarding cargados`,
    }],
    chips: null,
    matchedTurn: 12,
  };
}

export function buildTCustomersPrompt(): FastPathResult {
  return {
    answer: "¿Querés cargar tus clientes ahora?",
    actions: [],
    chips: T_CUSTOMERS_CHIPS,
    matchedTurn: 12,
  };
}

// ── T13: conectar ARCA/AFIP — BYOA via Administrador de Relaciones ───────────

export function buildTArcaResult(choice: ConnectChoice): FastPathResult {
  if (choice === "connect") {
    return {
      answer:
        "Te abro AFIP en una pestaña nueva. Logueate, andá a " +
        "**Administrador de Relaciones → Delegar Servicios** y delegá a " +
        "**Velora** (CUIT [CUIT del negocio]). " +
        "Cuando termines, volvé y pasame **tu CUIT** así te lo registro.",
      actions: [{
        intent: "update_business_setup",
        data: { field: "arcaDelegationPendingStep", value: "awaiting_cuit" },
        summary: "ARCA BYOA: esperando CUIT del dueño después de delegar en AFIP",
      }],
      chips: null,
      clientAction: "open_external_account",
      clientActionParams: {
        url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml",
        service: "afip",
      },
      matchedTurn: 13,
    };
  }
  // defer — persist the flag so the turn does NOT re-fire next message.
  return {
    answer: "Ok, lo conectás cuando emitas tu primera factura.",
    actions: [{
      intent: "update_business_setup",
      data: { field: "arcaOnboardingDeferred", value: true },
      summary: "Conexión ARCA diferida por el dueño",
    }],
    chips: null,
    matchedTurn: 13,
  };
}

export function buildTArcaCuitReceivedResult(canonicalCuit: string): FastPathResult {
  return {
    answer:
      `Listo, AFIP conectado con CUIT ${canonicalCuit}. ` +
      "(Modo demo: las facturas son simuladas hasta que actives modo real desde Cloud Run.)",
    actions: [
      {
        intent: "update_business_setup",
        data: { field: "arcaDelegationCuit", value: canonicalCuit },
        summary: `CUIT ${canonicalCuit} registrado para delegación ARCA`,
      },
      {
        intent: "update_business_setup",
        data: { field: "arcaDelegationPendingStep", value: null },
        summary: "ARCA BYOA: pending step limpiado",
      },
    ],
    chips: null,
    matchedTurn: 13,
  };
}

export function buildTArcaPrompt(): FastPathResult {
  return {
    answer: "¿Querés conectar AFIP para emitir facturas oficiales?",
    actions: [],
    chips: T_ARCA_CHIPS,
    matchedTurn: 13,
  };
}

// ── T14: conectar Andreani — BYOA via Andreani Developers ────────────────────

export function buildTAndreaniResult(choice: ConnectChoice, courierPreference: string | null): FastPathResult {
  const name = courierDisplayName(courierPreference);
  if (choice === "connect") {
    return {
      answer:
        `Te abro Andreani Developers en una pestaña nueva. ` +
        `Logueate, andá a **Credenciales API** y copiame el **token**. ` +
        `Cuando lo tengas, pegámelo acá.`,
      actions: [{
        intent: "update_business_setup",
        data: { field: "andreaniTokenPendingStep", value: "awaiting_token" },
        summary: `${name} BYOA: esperando token de Andreani Developers`,
      }],
      chips: null,
      clientAction: "open_external_account",
      clientActionParams: {
        url: "https://developers.andreani.com",
        service: "andreani",
      },
      matchedTurn: 14,
    };
  }
  // defer — persist the flag so the turn does NOT re-fire next message.
  return {
    answer: "Ok, lo conectás cuando hagas tu primer envío.",
    actions: [{
      intent: "update_business_setup",
      data: { field: "andreaniOnboardingDeferred", value: true },
      summary: `Conexión ${name} diferida por el dueño`,
    }],
    chips: null,
    matchedTurn: 14,
  };
}

export function buildTAndreaniTokenReceivedResult(encryptedToken: string, courierPreference: string | null): FastPathResult {
  const name = courierDisplayName(courierPreference);
  return {
    answer:
      `Listo, ${name} conectado. ` +
      "(Modo demo: los envíos son simulados hasta que actives modo real.)",
    actions: [
      {
        intent: "update_business_setup",
        data: { field: "andreaniApiToken", value: encryptedToken },
        summary: `Token de ${name} encriptado y guardado`,
      },
      {
        intent: "update_business_setup",
        data: { field: "andreaniTokenPendingStep", value: null },
        summary: "Andreani BYOA: pending step limpiado",
      },
    ],
    chips: null,
    matchedTurn: 14,
  };
}

export function buildTAndreaniPrompt(courierPreference: string | null): FastPathResult {
  const name = courierDisplayName(courierPreference);
  return {
    answer: `¿Querés conectar ${name} para cotizar y crear envíos?`,
    actions: [],
    chips: buildCourierConnectChips(courierPreference),
    matchedTurn: 14,
  };
}
