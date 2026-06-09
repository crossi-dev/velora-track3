// Payment provider adapter interface + factory.
// Mirrors the Logística agent's provider abstraction pattern.
// Switch providers via PAYMENT_PROVIDER_OVERRIDE env var ("mercadopago" | "alias_cbu").
// Business.paymentProvider DB column allows per-business overrides in the future.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import type { BizSnapshot } from "./payments-agent-types";
import { MercadoPagoAdapter } from "./providers/mp-adapter";
import { AliasCbuAdapter } from "./providers/alias-cbu-adapter";
import { ModoAdapter } from "./providers/modo-adapter";

// ── Shared result types ───────────────────────────────────────────────────────

/** Returned by createCollection. URL-based providers set checkoutUrl;
 *  instruction-based ones (e.g. CBU/alias) set instructions instead. */
export interface CollectionResult {
  paymentIntentId: string;
  amountARS: number;
  /** Checkout URL for redirect-based providers (e.g. MP Checkout Pro). */
  checkoutUrl?: string;
  /** Human-readable instructions for instruction-based providers. */
  instructions?: string;
  /** Provider-side reference (e.g. MP preferenceId). Stored in PaymentIntent.providerRef. */
  providerRef?: string;
  status: "pending";
  currency: "ARS";
}

export interface PaymentStatusResult {
  paymentIntentId: string;
  status: "pending" | "approved" | "rejected" | "refunded" | "disputed" | "error";
  /** Provider-side payment ID (different namespace from preferenceId in MP). */
  providerRef?: string;
  detail?: unknown;
  /** Optional user-facing message (Spanish) for error states. */
  message?: string;
  currency: "ARS";
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface PaymentProviderAdapter {
  createCollection(params: {
    paymentIntentId: string;
    amountARS: number;
    description: string;
    customerName?: string;
    businessId: string;
    /** Optional itemized breakdown. When supplied, the MP preference shows
     *  individual product lines + shipping instead of a single global item. */
    items?: Array<{ title: string; quantity: number; unit_price: number }>;
    shipping?: { cost: number; label: string };
    /** Prefetched MP connection row — skips mpConnection.findUnique inside getMpTokenForBusiness. */
    prefetchedMpConnection?: { accessTokenCiphertext: string | null; expiresAt: Date; scope: string | null } | null;
    /** Prefetched business name — skips business.findUnique inside createMpPreference. */
    prefetchedBusinessName?: string | null;
    /** Optional link lifetime in days. URL-based providers (MP) translate this into
     *  the provider's link-expiry field. Omitted = the provider's default (no expiry
     *  injected), preserving the in-person path. Threaded to the adapter ONLY — the
     *  Sale/PaymentIntent use-case does not carry this (DB expiresAt stays at 60min). */
    expiresInDays?: number;
  }): Promise<CollectionResult | { error: string; detail?: unknown }>;

  getStatus(params: {
    paymentIntentId: string;
    businessId: string;
  }): Promise<PaymentStatusResult>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

// ── Sentinel returned when no provider is connected ──────────────────────────

/** Sentinel adapter returned when no payment provider is connected.
 *  Every operation returns { error: "payment_provider_not_connected" } so the
 *  Payments agent can surface "connect MP" guidance to the owner.
 *
 *  ENCAJONAMIENTO 2026-05-25: alias/CBU auto-fallback removed.
 *  To un-encajonar: restore the auto-fallback branch in getPaymentProvider
 *  (search for "ALIAS_CBU_ENCAJONADO") and re-add Ejemplo 6 in
 *  payments-agent-helpers.ts. AliasCbuAdapter code is intact — just unreachable
 *  via the factory for businesses without an explicit paymentProvider setting. */
class NotConnectedAdapter implements PaymentProviderAdapter {
  async createCollection(): Promise<{ error: string }> {
    return { error: "payment_provider_not_connected" };
  }

  async getStatus(params: { paymentIntentId: string; businessId: string }): Promise<PaymentStatusResult> {
    return {
      paymentIntentId: params.paymentIntentId,
      status: "error",
      message: "Tu proveedor de pago no está conectado. Configuralo en Ajustes.",
      currency: "ARS",
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Returns the active payment provider adapter for the given business.
 *  Resolution order:
 *    1. PAYMENT_PROVIDER_OVERRIDE env var (platform-wide override for tests/staging)
 *    2. Business.paymentProvider DB column (per-business explicit opt-in)
 *    3. MP connection present → MercadoPagoAdapter
 *    4. No provider connected → NotConnectedAdapter (surfaces "connect MP" error)
 *
 *  NOTE — ALIAS_CBU_ENCAJONADO 2026-05-25:
 *  The previous auto-fallback (alias set + no MP → alias_cbu) has been removed.
 *  alias_cbu is still reachable via PAYMENT_PROVIDER_OVERRIDE or an explicit
 *  Business.paymentProvider = "alias_cbu" DB setting (owner explicit opt-in).
 */
/** Returns the active payment provider adapter for the given business.
 *  When `snapshot` is supplied (prefetched by the RPC handler), skips the two
 *  DB queries (business + mpConnection) — saves 2 roundtrips per tool call.
 */
export async function getPaymentProvider(businessId: string, snapshot?: BizSnapshot | null): Promise<PaymentProviderAdapter> {
  // Re-read on every call so the env toggle takes effect without restart.
  const envOverride = (process.env.PAYMENT_PROVIDER_OVERRIDE ?? "").trim().toLowerCase();
  if (envOverride) {
    return resolveAdapter(envOverride);
  }

  // Use prefetched snapshot when available; fall back to DB queries.
  let explicitProvider: string;
  let hasMpConn: boolean;
  if (snapshot) {
    explicitProvider = (snapshot.paymentProvider ?? "").trim().toLowerCase();
    hasMpConn = snapshot.hasMpConnection;
  } else {
    const [business, mpConn] = await Promise.all([
      prisma.business.findUnique({
        where: { id: businessId },
        select: { paymentProvider: true },
      }),
      prisma.mpConnection.findUnique({ where: { businessId }, select: { id: true } }),
    ]);
    explicitProvider = (business?.paymentProvider ?? "").trim().toLowerCase();
    hasMpConn = Boolean(mpConn);
  }

  // Explicit non-MP provider (e.g. alias_cbu via DB opt-in) → honour it directly.
  if (explicitProvider && explicitProvider !== "mercadopago") {
    return resolveAdapter(explicitProvider);
  }

  // Default MP path: only route to MercadoPagoAdapter when an MP connection exists.
  if (hasMpConn) {
    return resolveAdapter("mercadopago");
  }

  // No provider connected — return the sentinel so the agent surfaces guidance.
  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "PAYMENTS_PROVIDER_NOT_CONNECTED",
    a2a_transfer: false,
    message: "No payment provider connected — returning NotConnectedAdapter",
    data: { businessId },
  });
  return new NotConnectedAdapter();
}

function resolveAdapter(name: string): PaymentProviderAdapter {
  switch (name) {
    case "mercadopago":
      return new MercadoPagoAdapter();
    case "alias_cbu":
      return new AliasCbuAdapter();
    case "modo":
      return new ModoAdapter();
    default:
      // Unknown provider name — log a WARNING and return the sentinel adapter so
      // a misconfigured Business.paymentProvider (e.g. "modo_test") never silently
      // falls back to MP and creates unexpected charges under the wrong account.
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "PAYMENTS_UNKNOWN_PROVIDER",
        a2a_transfer: false,
        message: `Unknown payment provider "${name}" — returning NotConnectedAdapter (no silent MP fallback)`,
        data: { providerName: name },
      });
      return new NotConnectedAdapter();
  }
}
