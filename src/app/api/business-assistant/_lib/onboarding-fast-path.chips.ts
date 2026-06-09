// Chips canónicas reutilizadas por el Fast Path del onboarding — espejo
// exacto de las que el OnboardingAgent emite (onboarding-agent.prompt.ts).
// Centralizadas acá para que el fast-path y el LLM compartan una sola fuente.

import type { ChipsBundle } from "@/app/api/supervisor/_lib/supervisor-chips";

// T2: tipo de negocio — B2B vocabulary (Fase B)
export const T2_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Distribuidora", value: "Distribuidora" },
    { label: "Mayorista", value: "Mayorista" },
    { label: "Proveedor", value: "Proveedor" },
    { label: "Fabricante", value: "Fabricante" },
    { label: "Otro", value: "Otro" },
  ],
};

// T3: métodos de pago
export const T3_CHIPS: ChipsBundle = {
  kind: "multi",
  options: [
    { label: "Efectivo", value: "Efectivo" },
    { label: "Mercado Pago", value: "Mercado Pago" },
    { label: "Tarjeta", value: "Tarjeta" },
    { label: "Transferencia", value: "Transferencia" },
  ],
};

// T5: cómo cargar el primer producto. 3 opciones, todas resuelven dentro
// del chat sin que el owner salga: foto (cámara/galería + Gemini extract),
// archivo (file picker + upload-file endpoint), o manual (tipear acá).
export const T5_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Foto del cuaderno", value: "foto" },
    { label: "Subir Excel o CSV", value: "archivo" },
    { label: "Cargar manual", value: "manual" },
  ],
};

// T3_CATALOG_CHIPS: onboarding redesign 2026-05-25 — import-first catalog loading.
// Replaces the old T5_CHIPS (foto/archivo/manual) in the new T3 catalog turn.
// Primary chips (foto, planilla, pegar) all resolve inside chat.
// Tertiary option (skip) persists skippedCatalog flag and advances to T4.
export const T3_CATALOG_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Subí tu planilla", value: "archivo" },
    { label: "Foto del catálogo", value: "foto" },
    { label: "Pegá tu lista", value: "pegar" },
    { label: "No tengo todavía", value: "skip_catalogo" },
  ],
};

// T6: conectar Mercado Pago (solo se muestra cuando T3 incluyó MP)
export const T6_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Conectar Mercado Pago", value: "connect_mp" },
    { label: "Más tarde", value: "defer_mp" },
  ],
};

// T5 (courier): preferencia de courier del negocio.
// OCA + Correo Argentino encajonados 2026-05-25 — fuera del chip para que
// el dueño no pueda elegirlos (después T14 no podría conectarlos).
export const T5_COURIER_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Andreani", value: "Andreani" },
    { label: "No hago envíos", value: "ninguno" },
  ],
};

// T6 (WhatsApp): ingresar el teléfono o diferir
export const T6_WA_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Ingresarlo ahora", value: "wa_now" },
    { label: "Más tarde", value: "wa_defer" },
  ],
};

// T5b: binary choice after stock load — "another product?" or "done?"
// Values are exact members of T5D_CONTINUE_VALUES / T5D_FINISH_VALUES in
// onboarding-fast-path.parsers.t5d.ts so detectT5dChoice() accepts them.
export const T5B_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Cargar otro producto", value: "otro" },
    { label: "Ya está", value: "listo" },
  ],
};

// FS2 defer chip: "más tarde" for the fiscal punto-de-venta step.
// Value normalises via normalizeForMatching() → "mas tarde", which is in
// DEFER_PATTERNS inside onboarding-fast-path.fiscal-setup.ts.
export const FS2_DEFER_CHIP: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Más tarde", value: "mas tarde" },
  ],
};

// T12: carga de clientes — foto, cargar manual, subir archivo, o saltar.
// Paridad con T5 (productos): foto queda primero igual que allá.
export const T_CUSTOMERS_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Foto del cuaderno", value: "customers_foto" },
    { label: "Cargar manual", value: "customers_manual" },
    { label: "Subir Excel o CSV", value: "customers_archivo" },
    { label: "Saltar por ahora", value: "customers_saltar" },
  ],
};

// T13: facturas AFIP — usar sandbox por ahora vs conectar AFIP real.
// Sandbox YA está activo por default (ARCA_REAL_MODE=false). Elegir
// "Usar sandbox" persiste el flag deferred + da feedback claro de qué hace.
// "Conectar AFIP real" lleva al panel de credenciales (redirect a tab=servicios).
export const T_ARCA_CHIPS: ChipsBundle = {
  kind: "single",
  options: [
    { label: "Usar sandbox por ahora", value: "arca_defer" },
    { label: "Conectar AFIP real", value: "arca_connect" },
  ],
};

// T14: conectar courier (Andreani | OCA | Correo Argentino) — conectar o diferir.
// Chip label is dynamic: matches the courier the owner picked at T10 so the
// chat doesn't say "Conectar Andreani" to someone who picked OCA.
const COURIER_LABEL: Record<string, string> = {
  andreani: "Andreani",
  oca: "OCA",
  correo: "Correo Argentino",
};
export function buildCourierConnectChips(courierPreference: string | null): ChipsBundle {
  const key = (courierPreference ?? "").trim().toLowerCase();
  const label = COURIER_LABEL[key] ?? "courier";
  // Order: demo (default, instant) first, real (redirect) second. Matches the
  // T13 ARCA pattern and the prompt update of 2026-05-25.
  return {
    kind: "single",
    options: [
      { label: "Usar demo por ahora", value: "andreani_defer" },
      { label: `Conectar ${label} real`, value: "andreani_connect" },
    ],
  };
}
// Backward-compat alias for tests / static imports. Resolves to Andreani by default.
export const T_ANDREANI_CHIPS: ChipsBundle = buildCourierConnectChips("Andreani");
