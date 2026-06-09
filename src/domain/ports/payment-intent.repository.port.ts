export interface PaymentIntentPatchCheckoutArgs {
  paymentIntentId: string;
  businessId: string;
  providerRef: string;
  checkoutUrl: string;
}

export interface PaymentIntentPatchCheckoutResult {
  /** 1 = CAS write succeeded (providerRef was null); 0 = CAS missed (already set or id/businessId mismatch). */
  count: number;
}

export interface PaymentIntentRepositoryPort {
  /**
   * CAS-guarded write: sets providerRef + checkoutUrl only when providerRef is null.
   * Scoped by id + businessId — defense-in-depth tenant isolation.
   * Returns { count: 1 } on success, { count: 0 } on CAS miss.
   */
  patchCheckout(args: PaymentIntentPatchCheckoutArgs): Promise<PaymentIntentPatchCheckoutResult>;

  /**
   * Load the providerRef for a given intent, scoped by businessId.
   * Returns null ONLY when no row matches (not found, or belongs to another
   * tenant). A matched row returns { providerRef }, where providerRef may itself
   * be null (intent exists but is not yet linked to a provider). Callers must
   * distinguish these two cases: null = no intent; { providerRef: null } = unlinked.
   */
  findByIdAndBusiness(paymentIntentId: string, businessId: string): Promise<{ providerRef: string | null } | null>;
}
