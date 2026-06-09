// payment-link-sale-writeback.ts — HTTP client for the core internal endpoint.
//
// Phase 2 Payments: replaces the direct registerSaleWithPaymentLinkUseCase
// call in payments-agent-tools.ts with a POST to
// /api/internal/agents/payment-link-sale (gated by PAYMENTS_OVER_HTTP_ENABLED).
// Auth: CRON_SECRET bearer (same pattern as shipment-writeback.ts, S4).
//
// Error contract (hard stop): on any failure (network, timeout, non-2xx)
// throws PaymentLinkSaleWritebackError. The agent's existing error path handles
// this identically to today's in-process throw. This client does NOT retry —
// the use-case is idempotent (same idempotencyKey → "replayed"), so the
// CALLER may safely retry after catching PaymentLinkSaleWritebackError.
//
// Direction: VELORA_APP_URL (getCoreBaseUrl) — agent → core direction.
// Mirrors shipment-writeback.ts exactly.

import { getCoreBaseUrl } from "@/lib/core-base-url";
import { cloudLog } from "@/lib/cloud-logger";
import type {
  RegisterSaleWithPaymentLinkInput,
  RegisterSaleWithPaymentLinkResult,
} from "@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case";

// PAYMENTS_OVER_HTTP_ENABLED — feature flag for Phase 2 Payments HTTP cutover.
// When OFF (default): registerSaleWithPaymentLinkUseCase is called in-process —
//   byte-identical to the pre-cutover behavior.
// When ON: callPaymentLinkSaleEndpoint POST /api/internal/agents/payment-link-sale.
//   The use-case is idempotent (same idempotencyKey → "replayed"), so an HTTP
//   timeout AFTER the transaction commits is safe to retry.
// Read at call time (not module-load) so the toggle takes effect without a deploy.
export function isPaymentsOverHttpEnabled(): boolean {
  return process.env.PAYMENTS_OVER_HTTP_ENABLED === "true";
}

/** Thrown when the payment-link-sale writeback HTTP call fails. */
export class PaymentLinkSaleWritebackError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PaymentLinkSaleWritebackError";
  }
}

// 25s default (env-overridable).
//
// Why 25s: the use-case runs a 5-model Prisma transaction (customer lookup,
// product lookups × N, atomic Sale + SaleItem[] + Invoice + PaymentIntent +
// IdempotencyRecord + StockMovement × N + CashMovement). Under Supabase
// pgbouncer load (cold pool after scale-from-zero + connection-queue spikes)
// the transaction can run noticeably longer than the nominal 3-8s. The outer
// PAYMENTS_ADK_TIMEOUT_MS is 60s — this write is a sub-step, so 25s leaves
// ~35s for the subsequent MP preference API call while giving the DB write a
// generous ceiling.
//
// A tighter timeout would abort a write that was going to succeed, leaving the
// Payments agent unable to surface a checkoutUrl even though the Sale exists.
// (Idempotency makes a retry safe — same key returns "replayed" — but the
// customer would see a spurious failure, so we err wide. JD S7 W1 recommendation.)
const PAYMENT_LINK_SALE_WRITEBACK_TIMEOUT_MS =
  Number(process.env.PAYMENT_LINK_SALE_WRITEBACK_TIMEOUT_MS) || 25_000;

export async function callPaymentLinkSaleEndpoint(
  input: RegisterSaleWithPaymentLinkInput,
): Promise<RegisterSaleWithPaymentLinkResult> {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PAYMENT_LINK_SALE_WRITEBACK_NO_SECRET",
      a2a_transfer: false,
      message: "callPaymentLinkSaleEndpoint: CRON_SECRET is not set — cannot authenticate to core",
      data: { businessId: input.businessId, idempotencyKey: input.idempotencyKey },
    });
    throw new PaymentLinkSaleWritebackError("CRON_SECRET not configured");
  }

  const url = `${getCoreBaseUrl()}/api/internal/agents/payment-link-sale`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAYMENT_LINK_SALE_WRITEBACK_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PAYMENT_LINK_SALE_WRITEBACK_FETCH_ERROR",
      a2a_transfer: false,
      message: "callPaymentLinkSaleEndpoint: HTTP call to core failed",
      data: {
        businessId: input.businessId,
        idempotencyKey: input.idempotencyKey,
        errorName: err instanceof Error ? err.name : "NonError",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw new PaymentLinkSaleWritebackError(
      err instanceof Error ? err.message : "fetch_failed",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PAYMENT_LINK_SALE_WRITEBACK_HTTP_ERROR",
      a2a_transfer: false,
      message: `callPaymentLinkSaleEndpoint: core returned ${res.status}`,
      data: {
        businessId: input.businessId,
        idempotencyKey: input.idempotencyKey,
        status: res.status,
      },
    });
    throw new PaymentLinkSaleWritebackError(`non-200 from core: ${res.status}`, res.status);
  }

  const result = (await res.json()) as RegisterSaleWithPaymentLinkResult;
  return result;
}
