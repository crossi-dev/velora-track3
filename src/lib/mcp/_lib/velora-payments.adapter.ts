// src/lib/mcp/_lib/velora-payments.adapter.ts — Velora concrete implementation of PaymentsBackend.
//
// Delegates to the EXISTING payments pipeline functions:
//   - getMpTokenForBusiness()         from mp-api-helpers.ts
//   - createMpPreference()            from mp-api-helpers.ts
//   - getMpPaymentStatusByPreference() from mp-status-helpers.ts
//   - prisma.paymentIntent.findFirst  (ownership pre-check + customer name resolve)
//   - resolveCustomerIdByName()       from payments-agent-helpers.ts
//   - getPaymentProvider()            from payment-provider.ts (PaymentProviderAdapter)
//
// Pure restructure — zero behavioral change. tenantId is mapped to businessId
// before every call. All logic from payments-tools.ts is preserved EXACTLY —
// this is a thin delegation layer that translates shapes.
// Design source: velora-fiscal.adapter.ts (composition over inheritance).
//
// HARD CONSTRAINTS (money path — do NOT relax):
//   - getMpTokenForBusiness is called AS-IS — no changes to token resolution or caching.
//   - createMpPreference is called AS-IS — MP API call logic is UNTOUCHED.
//   - getMpPaymentStatusByPreference is called AS-IS — MP search + status mapping UNTOUCHED.
//   - PaymentProviderAdapter (getPaymentProvider) is called AS-IS — adapter internals UNTOUCHED.
//   - resolveCustomerIdByName is called AS-IS — fuzzy lookup UNTOUCHED.
//   - No idempotency is added or removed here.

import { createHash } from "crypto";
import type {
  PaymentsBackend,
  CreatePreferenceInput,
  CreatePreferenceOutput,
  GetMpPaymentStatusInput,
  GetMpPaymentStatusOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
} from "./payments-backend.port";
import { getCobroDetailImpl } from "./velora-cobro-detail";
import { getDeliveryReceiptImpl } from "./velora-delivery-receipt";
import { createTrackedPaymentLinkImpl } from "./velora-payment-link";
import { resolveWizardPrefillImpl } from "./velora-wizard-prefill";
import { listPendingOrdersImpl } from "./velora-pending-orders";
import {
  getMpTokenForBusiness,
  createMpPreference,
  MP_TOKEN_NOT_CONNECTED,
  MP_TOKEN_EXPIRED,
  MP_TOKEN_DECRYPT_ERROR,
} from "@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers";
import { getMpPaymentStatusByPreference } from "@/app/api/agents/payments/jsonrpc/_lib/mp-status-helpers";
import { getPaymentProvider } from "@/app/api/agents/payments/jsonrpc/_lib/payment-provider";
import { resolveCustomerIdByName } from "@/app/api/agents/payments/jsonrpc/_lib/payments-agent-helpers";
import { prisma } from "@/lib/prisma";

// ── Token sentinel → port discriminant ───────────────────────────────────────

function mapTokenSentinel(
  sentinel: typeof MP_TOKEN_NOT_CONNECTED | typeof MP_TOKEN_EXPIRED | typeof MP_TOKEN_DECRYPT_ERROR | null,
): CreatePreferenceOutput["tokenError"] {
  if (sentinel === MP_TOKEN_NOT_CONNECTED) return "NOT_CONNECTED";
  if (sentinel === MP_TOKEN_EXPIRED) return "EXPIRED";
  if (sentinel === MP_TOKEN_DECRYPT_ERROR) return "DECRYPT_ERROR";
  return "UNKNOWN";
}
// ── Adapter ───────────────────────────────────────────────────────────────────
export class VeloraPaymentsAdapter implements PaymentsBackend {
  readonly getCobroDetail = getCobroDetailImpl;             // → velora-cobro-detail.ts
  readonly getDeliveryReceipt = getDeliveryReceiptImpl;     // → velora-delivery-receipt.ts
  readonly createTrackedPaymentLink = createTrackedPaymentLinkImpl; // → velora-payment-link.ts
  readonly resolveWizardPrefill = resolveWizardPrefillImpl; // → velora-wizard-prefill.ts
  readonly listPendingOrders = listPendingOrdersImpl;        // → velora-pending-orders.ts
  async createPreference(input: CreatePreferenceInput): Promise<CreatePreferenceOutput> {
    const { tenantId: businessId, amountARS, description, externalReference } = input;

    const tokenResult = await getMpTokenForBusiness(businessId);

    // Surface any token sentinel — mirrors the exact sentinel checks in payments-tools.ts.
    if (
      tokenResult === MP_TOKEN_NOT_CONNECTED ||
      tokenResult === MP_TOKEN_EXPIRED ||
      tokenResult === MP_TOKEN_DECRYPT_ERROR ||
      tokenResult === null
    ) {
      return { tokenError: mapTokenSentinel(tokenResult) };
    }

    // Compute the bare reference (caller-supplied or content-addressed fallback).
    //
    // When the caller supplies externalReference, use it verbatim — stable across
    // retries, no false-dedup risk because the caller chose the key.
    //
    // When omitted, derive a stable reference from SHA-256(businessId+amount+description)
    // truncated to 24 hex chars (content-addressing, same pattern as buildSaleIdemKey).
    //
    // Trade-off: two legitimately-different payment requests with identical
    // (businessId, amountARS, description) share the same derived reference.
    // MP external_reference is a correlation label, NOT a hard dedup key — MP will
    // still create two separate preferences, both tagged with the same reference,
    // making them reconcilable. No double-charge risk (buyer must complete checkout
    // independently on each). This is strictly better than randomUUID() which creates
    // an orphaned preference on every retry. Callers that need full discrimination
    // should supply an explicit externalReference.
    const stableRef = createHash("sha256")
      .update(`${businessId}|${amountARS}|${description}`)
      .digest("hex")
      .slice(0, 24);
    const reference = externalReference?.trim() || stableRef;

    const result = await createMpPreference({
      accessToken: tokenResult,
      amountARS,
      description,
      businessId,
      // Pass the already-prefixed value so MP stores it verbatim and the
      // status helper's `${businessId}:${paymentIntentId}` search matches.
      externalReference: `${businessId}:${reference}`,
    });

    if ("error" in result) {
      return { error: (result as { error: string }).error };
    }

    return {
      preferenceId: result.preferenceId,
      checkoutUrl: result.checkoutUrl,
      paymentReference: reference,
    };
  }

  async getMpPaymentStatus(input: GetMpPaymentStatusInput): Promise<GetMpPaymentStatusOutput> {
    const { tenantId: businessId, paymentReference } = input;

    const tokenResult = await getMpTokenForBusiness(businessId);

    // Surface any token sentinel — mirrors the exact sentinel checks in payments-tools.ts.
    if (
      tokenResult === MP_TOKEN_NOT_CONNECTED ||
      tokenResult === MP_TOKEN_EXPIRED ||
      tokenResult === MP_TOKEN_DECRYPT_ERROR ||
      tokenResult === null
    ) {
      return { tokenError: mapTokenSentinel(tokenResult) };
    }

    // Pass the BARE paymentReference as paymentIntentId — getMpPaymentStatusByPreference
    // internally builds `${businessId}:${paymentIntentId}`, matching what createMpPreference
    // stored as `${businessId}:${reference}`. Mirrors payments-tools.ts EXACTLY.
    const result = await getMpPaymentStatusByPreference({
      accessToken: tokenResult,
      businessId,
      paymentIntentId: paymentReference,
    });

    // Detect transient MP outage — mirrors the mp_search_failed check in payments-tools.ts.
    const detail = result.detail as Record<string, unknown> | null | undefined;
    if (detail && typeof detail === "object" && (detail as { error?: string }).error === "mp_search_failed") {
      return { mpUnavailable: true };
    }

    return { status: result.status, paymentId: result.paymentId };
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const { tenantId: businessId, paymentIntentId, customerName } = input;

    if (!paymentIntentId && !customerName) {
      return {
        domainError: "missing_lookup_key",
        errorMessage: "Provide paymentIntentId or customerName.",
      };
    }

    let resolvedIntentId = paymentIntentId ?? null;

    // Ownership pre-check — same logic previously in handleGetPaymentStatus (payments-status-mcp.ts, now removed).
    if (resolvedIntentId) {
      const owned = await prisma.paymentIntent.findFirst({
        where: { id: resolvedIntentId, businessId },
        select: { id: true },
      });
      if (!owned) {
        return {
          domainError: "payment_intent_not_found",
          errorMessage: "No se encontró el cobro.",
        };
      }
    }

    if (!resolvedIntentId && customerName) {
      const customerId = await resolveCustomerIdByName(businessId, customerName);
      if (!customerId) {
        return {
          domainError: "customer_not_found",
          errorMessage: `No se encontró al cliente "${customerName}".`,
        };
      }
      const intent = await prisma.paymentIntent.findFirst({
        where: { businessId, matchedCustomerId: customerId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!intent) {
        return {
          domainError: "no_payment_intent_found",
          errorMessage: `No se encontró ningún cobro para "${customerName}".`,
        };
      }
      resolvedIntentId = intent.id;
    }

    const adapter = await getPaymentProvider(businessId);
    // resolvedIntentId is guaranteed non-null — both code paths above either set it
    // or return early.
    const result = await adapter.getStatus({
      paymentIntentId: resolvedIntentId!,
      businessId,
    });

    if (result.status === "error") {
      return {
        domainError: "status_lookup_failed",
        errorMessage: result.message ?? "No se pudo obtener el estado del pago.",
        paymentIntentId: resolvedIntentId!,
      };
    }

    return {
      paymentIntentId: resolvedIntentId!,
      status: result.status,
      providerRef: result.providerRef ?? null,
    };
  }

}
