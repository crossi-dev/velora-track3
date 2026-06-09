// mp-status-helpers.ts — MP payment status query helper.
// Extracted from mp-api-helpers.ts to keep that file under the 300-line limit.

import { MercadoPagoConfig, Payment } from "mercadopago";
import { MP_HTTP_TIMEOUT_MS } from "./mp-api-helpers";
import { mpSdkWithRetry } from "./mp-fetch-retry";
import { mapMpStatusToVeloraStatus } from "@/app/api/integrations/mp/_lib/mp-status-mapping";
import type { VeloraPaymentStatus } from "@/app/api/integrations/mp/_lib/mp-status-mapping";

// Resolves a Velora PaymentIntent to its MP payment(s) via the payments search
// endpoint. Uses `external_reference={businessId}:{paymentIntentId}` because
// MP's search API rejects `preference_id` as an unknown parameter (returns 400 —
// confirmed via 2026-05-26 reconcile audit). external_reference is stable, set
// by Velora at preference creation, and unique per PI.
//
// Uses the official mercadopago v3 SDK for the HTTP transport, wrapped in
// mpSdkWithRetry to restore 429 resilience (SDK only retries 5xx natively).
// Token resolution/encryption is unchanged — only the fetch is replaced.
export async function getMpPaymentStatusByPreference(params: {
  accessToken: string;
  businessId: string;
  paymentIntentId: string;
}): Promise<{ status: VeloraPaymentStatus; paymentId: string | null; detail: unknown }> {
  const externalReference = `${params.businessId}:${params.paymentIntentId}`;

  const mpClient = new MercadoPagoConfig({ accessToken: params.accessToken });
  const payment = new Payment(mpClient);
  // retries: 1 disables SDK-internal retry — mpSdkWithRetry is the sole retry authority.
  const reqOpts = { timeout: MP_HTTP_TIMEOUT_MS, retries: 1 };

  try {
    const sdkRes = await mpSdkWithRetry(
      () => payment.search({
        options: {
          external_reference: externalReference,
          sort: "date_created",
          criteria: "desc",
          limit: 1,
        },
        requestOptions: reqOpts,
      }),
      "payment.search",
    );

    // SDK success: { results: [...], paging: {...}, api_response: {...} }
    const results = Array.isArray(sdkRes?.results) ? sdkRes.results as Record<string, unknown>[] : [];
    if (results.length === 0) {
      // Preference exists but buyer has not completed payment yet.
      return { status: "pending", paymentId: null, detail: { externalReference } };
    }

    const first = results[0];
    const paymentId = first.id != null ? String(first.id) : null;
    // Map raw MP status to Velora canonical status at the helper boundary so all
    // callers receive an already-normalised value. Source: mp-status-mapping.ts.
    return {
      status: mapMpStatusToVeloraStatus(String(first.status ?? "unknown")),
      paymentId,
      detail: first,
    };
  } catch (err) {
    // SDK throws the parsed error JSON on non-2xx (RestClient: throw await response.json()).
    // The thrown object includes `status` (HTTP status code from the MP error body).
    const httpStatus = err && typeof err === "object"
      ? (err as Record<string, unknown>).status
      : undefined;
    return {
      status: "rejected",
      paymentId: null,
      detail: { error: "mp_search_failed", httpStatus, body: err },
    };
  }
}
