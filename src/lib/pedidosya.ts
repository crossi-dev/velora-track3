// src/lib/pedidosya.ts — PedidosYa delivery facade (BYOA, fail-closed).
//
// BYOA: credentials are loaded per-business from BusinessChannelCredential (DB).
// PEDIDOSYA_API_TOKEN env is a global fallback only. If a business hasn't
// connected PedidosYa (and no env fallback), the call fails-closed.
//
// Fail-closed: credential absent → clear "not connected" error result.
// Never throws uncaught — always returns { ok: true, ... } or { ok: false, error }.
//
// Real API: POST /v3/shippings/estimates via pedidosya-api-client.ts.
// API source (OpenAPI spec HTTP 200 verified 2026-06-04):
//   https://developers.pedidosya.com/courier-api/v3.json

import { cloudLog } from "@/lib/cloud-logger";
import { loadPedidosYaCredentials } from "@/infrastructure/messaging/messaging-credential-loader";
import {
  envPedidosYaToken,
  fetchPedidosYaEstimate,
} from "@/app/api/agents/logistica/jsonrpc/_lib/providers/pedidosya-api-client";

export interface QuotePedidosYaParams {
  /** Pickup address (origin). */
  pickupAddress: string;
  /** Delivery address (destination). */
  deliveryAddress: string;
  /** Package weight in kg. */
  weightKg: number;
}

export type PedidosYaQuoteResult =
  | { ok: true; estimatedMinutes: number; priceCents: number; quoteId: string }
  | { ok: false; error: string };

/**
 * Quote a PedidosYa delivery using per-business credentials.
 * businessId is REQUIRED — credentials are tenant-scoped (BYOA).
 * Fails-closed with a clear error if the business hasn't connected PedidosYa.
 */
export async function quotePedidosYa(
  params: QuotePedidosYaParams,
  businessId: string,
): Promise<PedidosYaQuoteResult> {
  const creds = await loadPedidosYaCredentials(businessId);
  const token = creds?.apiToken ?? (envPedidosYaToken() || null);

  if (!token) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "PEDIDOSYA_QUOTE_NO_CREDENTIALS",
      a2a_transfer: false,
      message: "PedidosYa quote skipped — no credentials configured for this business (fail-closed).",
      businessId,
      data: { pickupAddress: params.pickupAddress, deliveryAddress: params.deliveryAddress },
    });
    return {
      ok: false,
      error: "PedidosYa no configurado: conectá tu cuenta en Ajustes → Servicios.",
    };
  }

  try {
    const result = await fetchPedidosYaEstimate(
      token,
      {
        originAddress: params.pickupAddress,
        destinationAddress: params.deliveryAddress,
        weightGrams: Math.round(params.weightKg * 1000),
      },
      params.pickupAddress,
      params.deliveryAddress,
    );

    const best = result.options[0];
    if (!best) {
      return { ok: false, error: "PedidosYa no devolvió opciones de envío para esta dirección." };
    }
    return {
      ok: true,
      estimatedMinutes: best.estimatedMinutes ?? 0,
      priceCents: Math.round(best.priceARS * 100),
      quoteId: result.options.length > 0 ? `pya-${businessId.slice(-6)}-${Date.now()}` : "",
    };
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "PEDIDOSYA_QUOTE_FAILED",
      a2a_transfer: false,
      message: "PedidosYa quote failed.",
      businessId,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return { ok: false, error: "PedidosYa: no se pudo cotizar el envío en este momento." };
  }
}
