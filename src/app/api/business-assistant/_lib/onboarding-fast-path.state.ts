// OnboardingFastPathState — snapshot of the Business fields the state machine
// reads to decide which onboarding turn is pending. Pure data — no DB calls.
// Exported from this sibling so onboarding-fast-path.ts stays under 300 LOC.

export interface OnboardingFastPathState {
  businessNameSet: boolean;
  businessTypeSet: boolean;
  paymentMethodsSet: boolean;
  // T3b: alias/CBU collected (only required when paymentMethods includes "Transferencia").
  // Use paymentMethodsIncludeTransferencia + transferAlias to derive the need rather than
  // relying on the pre-computed boolean, so detectPendingTurn is self-contained.
  transferAliasSet: boolean;
  // Raw fields for safe alias-need derivation (added 2026-05-19 fix).
  paymentMethodsIncludeTransferencia: boolean;
  transferAlias: string | null;
  // T4: business postal code (logistics origin for Andreani quotes).
  postalCodeSet: boolean;
  // T5: courier preference (Andreani | OCA | Correo | ninguno).
  courierPreferenceSet: boolean;
  // T10 raw value — needed by T14 builder to render the correct chip label/panel
  // for the owner's actual courier choice. null when not yet set.
  courierPreference: string | null;
  // T6: WhatsApp phone for the business (can be empty-string sentinel for "deferred").
  whatsappPhoneSet: boolean;
  productCount: number;
  // T7b/T7c: producto recién creado esperando cantidad inicial. Incluye el
  // productId para emitir adjust_stock con ID real (sin fallback por nombre).
  // Null cuando no hay producto pendiente de stock.
  pendingStockProduct: { productId: string; name: string } | null;
  // T9: derived from paymentMethods (T3 included "Mercado Pago").
  mercadoPagoSelected: boolean;
  // T9: true if MpConnection row exists for this business.
  mercadoPagoConnected: boolean;
  // T9: true when the owner deferred the MP connection step ("Más tarde").
  mercadoPagoOnboardingDeferred: boolean;
  // T12/T13/T14 done conditions + explicit-defer flags. Done = natural
  // condition true OR defer flag true. Defer flags persist on Business so
  // the chat does not re-prompt the same turn on the next message.
  customerCount: number;
  customersOnboardingSkipped: boolean;
  arcaCertConnected: boolean;
  arcaOnboardingDeferred: boolean;
  // T14 also treats courierPreference === "ninguno" as connected (no creds needed).
  courierCredentialsConnected: boolean;
  andreaniOnboardingDeferred: boolean;
  // BYOA pending steps — set when the owner clicked "connect" and opened the
  // external provider portal, but hasn't pasted back the credential yet.
  // "awaiting_cuit" | null for AFIP; "awaiting_token" | null for Andreani.
  arcaPendingStep: string | null;
  andreaniPendingStep: string | null;
  // Onboarding redesign 2026-05-25: new flags for T3 (catalog) and T4 (first sale).
  // skippedCatalog: owner tapped "No tengo todavía" — catalog turn is resolved.
  // firstSalePromptShown: T4 guided first-sale message was already shown once.
  skippedCatalog: boolean;
  firstSalePromptShown: boolean;
}
