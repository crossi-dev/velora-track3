// SetupChecklist.helpers.ts — pure helpers and types for SetupChecklist.tsx.
// Extracted so SetupChecklist.tsx stays within the 400-line area limit.

import type { BusinessCapabilities } from "@/lib/business-capabilities";

// ── Constants ─────────────────────────────────────────────────────────────────

export const COLLAPSE_STORAGE_KEY = "velora-setup-checklist-collapsed";
// Dismiss = hidden entirely (vs collapse = minimized to header). Setup cards are
// dismissible via an explicit control — the pattern used by Stripe/Shopify and
// mandated by Atlassian Onboarding ("Dismiss is critical"). Persisted like the
// collapse key so the choice survives reloads. Source (in file header):
// https://atlassian.design/components/onboarding/
export const DISMISS_STORAGE_KEY = "velora-setup-checklist-dismissed";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Tier classification — Stripe Incremental Onboarding pattern.
 *   "now"   → currently_due: high-value first steps that unblock the core loop.
 *   "later" → eventually_due: optional integrations collected JIT, not at sign-up.
 * Source (verified HTTP 200): https://docs.stripe.com/connect/custom/hosted-onboarding
 */
export type ChecklistItemTier = "now" | "later";

export interface ChecklistItem {
  id: string;
  label: string;
  /** One-line didactic explanation shown under the label (beginner-friendly). */
  explain: string;
  done: boolean;
  /** Action CTA label. */
  actionLabel: string;
  /** What happens when the owner clicks the action button. */
  onAction: () => void;
  /**
   * Tier classification (Stripe currently_due / eventually_due pattern).
   * "now" = must-do first steps that unblock the core loop;
   * "later" = optional integrations collected JIT once the business is running.
   */
  tier: ChecklistItemTier;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

export function readCollapsedFromStorage(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeCollapsedToStorage(collapsed: boolean): void {
  try {
    if (collapsed) {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(COLLAPSE_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable (private mode, quota exceeded) — fail silently.
  }
}

export function readDismissedFromStorage(): boolean {
  try {
    return localStorage.getItem(DISMISS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDismissedToStorage(dismissed: boolean): void {
  try {
    if (dismissed) {
      localStorage.setItem(DISMISS_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(DISMISS_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable — fail silently.
  }
}

// ── Item builder ──────────────────────────────────────────────────────────────

export function buildChecklistItems(
  capabilities: BusinessCapabilities,
  hasProducts: boolean,
  goToServicios: () => void,
  goToMain: () => void,
): ChecklistItem[] {
  // Tier assignment (Stripe Incremental Onboarding — currently_due / eventually_due):
  //   "now"   → Cargar catálogo + Conectar WhatsApp: unblock the first sale.
  //   "later" → Mercado Pago + Andreani + AFIP: valuable but not required day 1.
  // Source (verified HTTP 200): https://docs.stripe.com/connect/custom/hosted-onboarding
  return [
    {
      id: "stock",
      label: "Cargar tu catálogo",
      explain: "Subí tus productos para vender desde el chat y manejar el stock.",
      done: hasProducts,
      actionLabel: "Cargar",
      onAction: goToMain,
      tier: "now" as ChecklistItemTier,
    },
    {
      id: "whatsapp",
      label: "Conectar WhatsApp",
      explain: "Atendé pedidos y enviá comprobantes automáticos por WhatsApp Business.",
      done: capabilities.whatsapp_business || capabilities.whatsapp_phone,
      actionLabel: "Conectar",
      onAction: goToServicios,
      tier: "now" as ChecklistItemTier,
    },
    {
      id: "mercadopago",
      label: "Conectar Mercado Pago",
      explain: "Cobrá con link de pago o QR. Cada venta confirma automáticamente en Velora.",
      done: capabilities.mercadopago,
      actionLabel: "Conectar",
      // MP OAuth → existing connect endpoint (same as clientAction:"open_mp_oauth").
      // Source: useAssistantStreaming.clientActions.ts — /api/integrations/mp/connect
      onAction: () => { window.location.href = "/api/integrations/mp/connect"; },
      tier: "later" as ChecklistItemTier,
    },
    {
      id: "andreani",
      label: "Conectar Andreani",
      explain: "Cotizá envíos y despachá paquetes sin salir del chat.",
      done: capabilities.andreani,
      actionLabel: "Conectar",
      onAction: goToServicios,
      tier: "later" as ChecklistItemTier,
    },
    {
      id: "afip",
      label: "Conectar AFIP",
      explain: "Emitite facturas oficiales (A, B, C) contra ARCA automáticamente.",
      done: capabilities.arca,
      actionLabel: "Conectar",
      onAction: goToServicios,
      tier: "later" as ChecklistItemTier,
    },
  ];
}
