// register-promesa-sale-writeback.ts — HTTP client for the core internal endpoint.
//
// Phase 2 Payments: replaces the direct registerPromesaSaleUseCase call in
// payments-register-promesa-sale-tool.ts with a POST to
// /api/internal/agents/promesa-sale (gated by PROMESA_SALE_OVER_HTTP_ENABLED).
// Auth: CRON_SECRET bearer (same pattern as payment-link-sale-writeback.ts).
//
// Error contract (hard stop): on any failure (network, timeout, non-2xx)
// throws PromesaSaleWritebackError. The agent's existing error path handles
// this identically to today's in-process throw. This client does NOT retry —
// the use-case is idempotent (same inputs → same derived key → "replayed"),
// so the CALLER may safely retry after catching PromesaSaleWritebackError.
//
// Direction: VELORA_APP_URL (getCoreBaseUrl) — agent → core direction.
// Mirrors payment-link-sale-writeback.ts exactly.

import { getCoreBaseUrl } from "@/lib/core-base-url";
import { cloudLog } from "@/lib/cloud-logger";
import type {
  RegisterPromesaSaleInput,
  RegisterPromesaSaleResult,
} from "@/app/api/payment-intents/_lib/register-promesa-sale-use-case";

// PROMESA_SALE_OVER_HTTP_ENABLED — feature flag for the promesa-sale HTTP cutover.
// When OFF (default): registerPromesaSaleUseCase is called in-process —
//   byte-identical to the pre-cutover behavior.
// When ON: callPromesaSaleEndpoint POST /api/internal/agents/promesa-sale.
//   The use-case is idempotent (same inputs → same derived key → "replayed"),
//   so an HTTP timeout AFTER the transaction commits is safe to retry.
// Read at call time (not module-load) so the toggle takes effect without a deploy.
export function isPromesaSaleOverHttpEnabled(): boolean {
  return process.env.PROMESA_SALE_OVER_HTTP_ENABLED === "true";
}

/** Thrown when the promesa-sale writeback HTTP call fails. */
export class PromesaSaleWritebackError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PromesaSaleWritebackError";
  }
}

// 25s default (env-overridable).
//
// Why 25s: the use-case runs a multi-model Prisma transaction (customer lookup,
// product lookups × N, atomic Sale + SaleItems + Invoice + CashMovement +
// PaymentIntent + IdempotencyRecord + StockMovement × N). Under Supabase
// pgbouncer load (cold pool after scale-from-zero + connection-queue spikes)
// the transaction can run noticeably longer than the nominal 3-8s. 25s gives
// the DB write a generous ceiling without tying up the outer ADK budget.
// (Idempotency makes a retry safe — same inputs return "replayed" — but the
// owner would see a spurious failure, so we err wide. Same reasoning as #71.)
const PROMESA_SALE_WRITEBACK_TIMEOUT_MS =
  Number(process.env.PROMESA_SALE_WRITEBACK_TIMEOUT_MS) || 25_000;

export async function callPromesaSaleEndpoint(
  input: RegisterPromesaSaleInput,
): Promise<RegisterPromesaSaleResult> {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PROMESA_SALE_WRITEBACK_NO_SECRET",
      a2a_transfer: false,
      message: "callPromesaSaleEndpoint: CRON_SECRET is not set — cannot authenticate to core",
      data: { businessId: input.businessId, customerId: input.customerId },
    });
    throw new PromesaSaleWritebackError("CRON_SECRET not configured");
  }

  const url = `${getCoreBaseUrl()}/api/internal/agents/promesa-sale`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMESA_SALE_WRITEBACK_TIMEOUT_MS);

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
      action: "PROMESA_SALE_WRITEBACK_FETCH_ERROR",
      a2a_transfer: false,
      message: "callPromesaSaleEndpoint: HTTP call to core failed",
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        errorName: err instanceof Error ? err.name : "NonError",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw new PromesaSaleWritebackError(
      err instanceof Error ? err.message : "fetch_failed",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PROMESA_SALE_WRITEBACK_HTTP_ERROR",
      a2a_transfer: false,
      message: `callPromesaSaleEndpoint: core returned ${res.status}`,
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        status: res.status,
      },
    });
    throw new PromesaSaleWritebackError(`non-200 from core: ${res.status}`, res.status);
  }

  const result = (await res.json()) as RegisterPromesaSaleResult;
  return result;
}
