// Onboarding session state — typed shape carried in the ADK Session.state
// for the LLM front-door onboarding agent.
//
// Architecture (sourced):
// - LLM front-door + session.state pattern: Google ADK
//   https://google.github.io/adk-docs/sessions/state/
// - Incremental Onboarding (currently_due vs eventually_due):
//   Stripe Connect — https://stripe.com/docs/connect/required-verification-information#incremental-verification
//
// The LLM agent reads `currently_due` to decide what to ask next; once both
// are filled, `onboarding_complete` flips true and the supervisor delegates to
// the regular business-assistant pipeline. `eventually_due` fields are collected
// JIT by the existing deterministic stages (fiscal-setup, etc.) when the action
// that needs them is invoked — those stages remain unchanged.
//
// Onboarding v3 (2026-06-04): currently_due is the MINIMAL set to start —
// business name + catalog. Payment + shipping moved to eventually_due (the
// SetupChecklist dashboard card), per Stripe incremental onboarding. They are
// NOT chat turns anymore.
// Source: https://docs.stripe.com/connect/custom/hosted-onboarding

export type PaymentMethod = "mercadopago" | "transferencia" | "efectivo";
export type ShippingProvider = "andreani" | "oca" | "correo" | "none";

/** Fields the LLM front-door collects upfront. Both gate onboarding completion. */
export interface OnboardingCurrentlyDue {
  /** Business display name. Set by save_business_name tool. */
  business_name: string | null;
  /** True when the owner uploaded a catalog or explicitly skipped. Set by import_catalog tool. */
  catalog_ready: boolean;
}

/**
 * Fields collected JIT by the existing deterministic stages, not by the
 * onboarding agent. Kept in session.state so downstream tools can read them
 * without a DB round-trip. The Business row remains the source of truth — these
 * fields are populated from the DB on session restore.
 */
export interface OnboardingEventuallyDue {
  business_postal_code: string | null;
  transfer_alias: string | null;
  whatsapp_phone: string | null;
  cuit: string | null;
  iva_condition: string | null;
  punto_venta: number | null;
  andreani_token_encrypted: string | null;
  customer_postal_code: string | null;
}

export interface OnboardingSessionState {
  currently_due: OnboardingCurrentlyDue;
  eventually_due: OnboardingEventuallyDue;
  /** True when all four currently_due fields are non-null. Computed, persisted. */
  onboarding_complete: boolean;
  /** Owner tapped "no tengo todavía" — catalog turn resolved without products. */
  catalog_skipped: boolean;
  /** Aha-moment first-sale prompt was already shown once. */
  first_sale_prompt_shown: boolean;
}

/** Default session.state for a brand-new business with zero data collected yet. */
export function makeInitialOnboardingSessionState(): OnboardingSessionState {
  return {
    currently_due: {
      business_name: null,
      catalog_ready: false,
    },
    eventually_due: {
      business_postal_code: null,
      transfer_alias: null,
      whatsapp_phone: null,
      cuit: null,
      iva_condition: null,
      punto_venta: null,
      andreani_token_encrypted: null,
      customer_postal_code: null,
    },
    onboarding_complete: false,
    catalog_skipped: false,
    first_sale_prompt_shown: false,
  };
}

/** Predicate: both currently_due fields are filled (name + catalog). */
export function isOnboardingComplete(state: OnboardingSessionState): boolean {
  const c = state.currently_due;
  return c.business_name !== null && c.catalog_ready === true;
}
