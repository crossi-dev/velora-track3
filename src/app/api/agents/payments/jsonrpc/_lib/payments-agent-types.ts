// Shared types for the Payments Agent — extracted to avoid circular imports
// between payments-agent-tools.ts, adk-payments-agent.ts, and payment-provider.ts.

/** Prefetched business data passed from handle-payments-rpc.ts.
 *  When present, tools skip their own business.findUnique calls to save
 *  DB roundtrips (critical under connection_limit=10 with parallel agents). */
export interface BizSnapshot {
  paymentProvider: string | null;
  postalCode: string | null;
  alias: string | null;
  whatsappPhone: string | null;
  cuit: string | null;
  hasMpConnection: boolean;
  /** Business display name — avoids a second business.findUnique inside createMpPreference. */
  name: string | null;
  /**
   * Courier preference ('andreani' | 'oca' | null) — avoids a second business.findUnique
   * inside create_payment_link when shippingRequired=true and ctx.bizSnapshot is used.
   * Finding 2: prefetched in handle-payments-rpc.ts alongside other business fields.
   */
  courierPreference: string | null;
  /**
   * Prefetched MP connection data — avoids the mpConnection.findUnique inside
   * getMpTokenForBusiness. Null when no MpConnection row exists.
   */
  mpConnectionRaw: {
    accessTokenCiphertext: string | null;
    expiresAt: Date;
    scope: string | null;
  } | null;
}

/** Context passed from handle-payments-rpc.ts into every payment tool factory.
 *  Carries per-request identity, idempotency scope, and optional prefetched data.
 *  Declared AFTER BizSnapshot to avoid TypeScript forward-reference errors. */
export interface PaymentToolCtx {
  businessId: string | null;
  actorUserId: string | null;
  turnId: string;
  bizSnapshot?: BizSnapshot | null;
}
