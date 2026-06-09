// Builders for the T3 catalog (import-first) onboarding turn.
// Onboarding redesign 2026-05-25: replaces the old T5 product-loading turn
// with an import-first UX (planilla / foto / pegar / skip).
// Split from onboarding-fast-path.builders.ts to keep that file at 300 LOC.
// All builders are pure — no context reads, no DB writes.

import { T3_CATALOG_CHIPS } from "./onboarding-fast-path.chips";
import type { FastPathResult } from "./onboarding-fast-path.builders";

// ── T3 catalog prompt — shown at the start of the catalog turn ────────────

export function buildT3CatalogPrompt(): FastPathResult {
  return {
    answer: "Cargá tu catálogo. ¿Cómo querés hacerlo?",
    actions: [],
    chips: T3_CATALOG_CHIPS,
    matchedTurn: 5,
  };
}

// ── T3 catalog mode selections ────────────────────────────────────────────

/** Owner chose "Subí tu planilla" (Excel / CSV / PDF / DOCX file picker). */
export function buildT3CatalogArchivoResult(): FastPathResult {
  return {
    answer: "Dale, tirá tu Excel, CSV, PDF o DOCX acá. Leo hasta 500 productos.",
    actions: [],
    chips: null,
    clientAction: "open_file_picker",
    matchedTurn: 5,
  };
}

/** Owner chose "Foto del catálogo" (camera capture). */
export function buildT3CatalogFotoResult(): FastPathResult {
  return {
    answer: "Dale, sacale una foto al catálogo o las etiquetas. Te abro la cámara.",
    actions: [{
      intent: "open_photo_picker",
      data: {},
      summary: "Abrir cámara para foto del catálogo",
    }],
    chips: null,
    clientAction: "open_photo_picker",
    clientActionParams: { context: "products" },
    matchedTurn: 5,
  };
}

/** Owner chose "Pegá tu lista" — open multi-line textarea for bulk paste. */
export function buildT3CatalogPegarResult(): FastPathResult {
  return {
    answer: "Dale, pegá tu lista acá. Un producto por línea: nombre y precio. Ej:\nalfajor 500\nbizcochuelo 1200",
    actions: [],
    chips: null,
    clientAction: "open_paste_textarea",
    matchedTurn: 5,
  };
}

/** Owner chose "No tengo todavía" — skip catalog, persist flag, advance to T4. */
export function buildT3CatalogSkipResult(): FastPathResult {
  return {
    answer: "Perfecto, lo cargás cuando tengas el catálogo listo. Seguimos.",
    actions: [{
      intent: "update_business_setup",
      data: { field: "skippedCatalog", value: true },
      summary: "Catálogo diferido por el dueño",
    }],
    chips: null,
    matchedTurn: 5,
  };
}
