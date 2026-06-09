// MercadoPago adapter — implements PaymentProviderAdapter for Checkout Pro links.
// Delegates all MP HTTP calls to mp-api-helpers.ts (unchanged).
// DB write-back (patchCheckout) goes through PaymentIntentRepositoryPort — no
// inline prisma calls for writes. The CAS guard and orphan-preference error path
// are preserved verbatim; only the persistence call site changes.

import { prismaPaymentIntentRepository } from "@/infrastructure/persistence/prisma-payment-intent.repository";
import { prisma } from "@/lib/prisma";
import {
  getMpTokenForBusiness,
  MP_TOKEN_NOT_CONNECTED,
  MP_TOKEN_EXPIRED,
  MP_TOKEN_DECRYPT_ERROR,
  createMpPreference,
  getMpPaymentStatusByPreference,
} from "../mp-api-helpers";
import { nudgeMpReconnect } from "../mp-reconnect-nudge";
import type {
  PaymentProviderAdapter,
  CollectionResult,
  PaymentStatusResult,
} from "../payment-provider";
import { cloudLog } from "@/lib/cloud-logger";

export class MercadoPagoAdapter implements PaymentProviderAdapter {
  async createCollection(params: {
    paymentIntentId: string;
    amountARS: number;
    description: string;
    customerName?: string;
    businessId: string;
    items?: Array<{ title: string; quantity: number; unit_price: number }>;
    shipping?: { cost: number; label: string };
    /** Prefetched MP connection row — skips mpConnection.findUnique inside getMpTokenForBusiness. */
    prefetchedMpConnection?: { accessTokenCiphertext: string | null; expiresAt: Date; scope: string | null } | null;
    /** Prefetched business name — skips business.findUnique inside createMpPreference. */
    prefetchedBusinessName?: string | null;
    /** Link lifetime in days → MP preference date_of_expiration. Omitted = no expiry. */
    expiresInDays?: number;
  }): Promise<CollectionResult | { error: string; detail?: unknown }> {
    const { paymentIntentId, amountARS, description, customerName, businessId, items, shipping, prefetchedMpConnection, prefetchedBusinessName, expiresInDays } = params;

    const tokenResult = await getMpTokenForBusiness(businessId, prefetchedMpConnection);
    if (tokenResult === MP_TOKEN_NOT_CONNECTED) {
      void nudgeMpReconnect(businessId, "not_connected");
      return {
        error: "payment_provider_not_connected",
        detail: "Conectá tu Mercado Pago en Ajustes antes de cobrar.",
      };
    }
    // Fix (MEDIUM): handle new sentinels with user-facing Spanish messages.
    if (tokenResult === MP_TOKEN_EXPIRED) {
      void nudgeMpReconnect(businessId, "expired");
      return {
        error: "payment_provider_token_expired",
        detail: "Tu Mercado Pago expiró, reconectalo en Ajustes.",
      };
    }
    if (tokenResult === MP_TOKEN_DECRYPT_ERROR) {
      void nudgeMpReconnect(businessId, "decrypt_error");
      return {
        error: "payment_token_decrypt_error",
        detail: "No se pudo leer el token de Mercado Pago. Reconectá tu cuenta en Ajustes.",
      };
    }
    if (!tokenResult) {
      return { error: "payment_provider_not_connected" };
    }
    const accessToken = tokenResult;

    // external_reference must be "{businessId}:{paymentIntentId}" — the
    // webhook parses this format to resolve businessId and look up the row.
    const externalReference = `${businessId}:${paymentIntentId}`;

    // Fix 5: wrap buildMpItems / createMpPreference in try/catch. An items-sum
    // mismatch inside buildMpItems throws synchronously; letting it escape to the
    // ADK tool runtime produces an unhandled rejection that surfaces as an opaque
    // "tool execution failed" event. Catching here returns a structured error
    // envelope so the ADK agent can surface a clean user-facing message.
    let result: Awaited<ReturnType<typeof createMpPreference>>;
    try {
      result = await createMpPreference({
        accessToken,
        amountARS,
        description,
        customerName,
        businessId,
        externalReference,
        ...(items && items.length > 0 ? { items } : {}),
        ...(shipping ? { shipping } : {}),
        ...(prefetchedBusinessName !== undefined ? { prefetchedBusinessName } : {}),
        ...(typeof expiresInDays === "number" ? { expiresInDays } : {}),
      });
    } catch (prefErr) {
      cloudLog({
        severity: "ERROR",
        component: "A2A",
        action: "MP_PREFERENCE_BUILD_FAILED",
        a2a_transfer: false,
        message: "createMpPreference threw (likely items sum mismatch)",
        data: {
          paymentIntentId,
          businessId,
          errorName: prefErr instanceof Error ? prefErr.name : "NonError",
          errorMessage: prefErr instanceof Error ? prefErr.message : String(prefErr),
        },
      });
      return {
        error: "preference_build_failed",
        detail: prefErr instanceof Error ? prefErr.message : "Error al construir la preferencia de pago.",
      };
    }

    if ("error" in result) {
      return { error: result.error, detail: result.detail };
    }

    // CAS guard (Finding 1): patchCheckout uses WHERE providerRef:null so concurrent
    // heals cannot overwrite each other. If another request already set providerRef,
    // count=0 and we log a race-lost warning instead of silently overwriting.
    // Reference: compare-and-swap pattern — Brandur "Idempotency Keys" 2017,
    // stripe.com/blog/idempotency. Defense-in-depth: patchCheckout is scoped by
    // id+businessId — cross-tenant write guard even if paymentIntentId leaked.
    // Fix 6: patchCheckout has no internal try/catch — it throws on DB error.
    // Wrapping in try/catch here preserves the existing behavior: a transient DB
    // error (connection loss, pgbouncer pool exhaustion) returns { error, duplicatePreferenceId }
    // so ops can identify the orphaned MP preference for cleanup without losing the preferenceId.
    let count: number;
    try {
      ({ count } = await prismaPaymentIntentRepository.patchCheckout({
        paymentIntentId,
        businessId,
        providerRef: result.preferenceId,
        checkoutUrl: result.checkoutUrl,
      }));
    } catch (updateErr) {
      cloudLog({
        severity: "ERROR",
        component: "A2A",
        action: "MP_UPDATE_MANY_FAILED",
        a2a_transfer: false,
        message: "paymentIntent.updateMany threw after MP preference created — orphaned preference likely",
        data: {
          paymentIntentId,
          businessId,
          duplicatePreferenceId: result.preferenceId,
          errorName: updateErr instanceof Error ? updateErr.name : "NonError",
          errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
        },
      });
      return {
        error: "patch_failed",
        detail: { duplicatePreferenceId: result.preferenceId },
      };
    }
    if (count === 0) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "PAYMENT_LINK_HEAL_RACE_LOST",
        a2a_transfer: false,
        message: `updateMany(providerRef) CAS missed — race: row already updated or id/businessId mismatch. Duplicate MP preference may need ops cleanup.`,
        data: { paymentIntentId, businessId, duplicatePreferenceId: result.preferenceId },
      });
    }

    return {
      paymentIntentId,
      amountARS,
      checkoutUrl: result.checkoutUrl,
      providerRef: result.preferenceId,
      status: "pending",
      currency: "ARS",
    };
  }

  async getStatus(params: {
    paymentIntentId: string;
    businessId: string;
  }): Promise<PaymentStatusResult> {
    const { paymentIntentId, businessId } = params;

    const tokenResult = await getMpTokenForBusiness(businessId);
    if (tokenResult === MP_TOKEN_NOT_CONNECTED) {
      void nudgeMpReconnect(businessId, "not_connected");
      return {
        paymentIntentId,
        status: "error",
        detail: "payment_provider_not_connected",
        message: "Conectá tu Mercado Pago en Ajustes antes de cobrar.",
        currency: "ARS",
      };
    }
    // Fix (MEDIUM): handle new sentinels with user-facing Spanish messages.
    if (tokenResult === MP_TOKEN_EXPIRED) {
      void nudgeMpReconnect(businessId, "expired");
      return {
        paymentIntentId,
        status: "error",
        detail: "payment_provider_token_expired",
        message: "Tu Mercado Pago expiró, reconectalo en Ajustes.",
        currency: "ARS",
      };
    }
    if (tokenResult === MP_TOKEN_DECRYPT_ERROR) {
      void nudgeMpReconnect(businessId, "decrypt_error");
      return {
        paymentIntentId,
        status: "error",
        detail: "payment_token_decrypt_error",
        message: "No se pudo leer el token de Mercado Pago. Reconectá tu cuenta en Ajustes.",
        currency: "ARS",
      };
    }
    if (!tokenResult) {
      return { paymentIntentId, status: "error", detail: "payment_provider_not_connected", currency: "ARS" };
    }
    const accessToken = tokenResult;

    // Load the MP preferenceId from the DB row (stored at createCollection time).
    // Scope by businessId (tenant guard) — a missing row could indicate cross-tenant leak.
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: paymentIntentId, businessId },
      select: { providerRef: true },
    });
    if (!intent) {
      return { paymentIntentId, status: "error", detail: "intent_not_found", currency: "ARS" };
    }
    const preferenceId = intent.providerRef ?? null;
    if (!preferenceId) {
      // Pre-migration intents (no providerRef): return a diagnosable detail so callers
      // can distinguish this from a real broken lookup.
      return { paymentIntentId, status: "error", detail: "intent_sin_provider_ref", currency: "ARS" };
    }

    // getMpPaymentStatusByPreference already returns a VeloraPaymentStatus —
    // no further mapping needed. HTTP errors from the helper surface as "rejected"
    // with a structured detail object. Search key is external_reference
    // ({businessId}:{paymentIntentId}) — MP rejects preference_id as unknown param.
    const result = await getMpPaymentStatusByPreference({ accessToken, businessId, paymentIntentId });

    return {
      paymentIntentId,
      status: result.status,
      providerRef: result.paymentId ?? undefined,
      detail: result.detail,
      currency: "ARS",
    };
  }
}
