// PedidosYa provider adapter for the Logística role-agent.
//
// API source (OpenAPI spec HTTP 200 verified 2026-06-04):
//   https://developers.pedidosya.com/courier-api/v3.json
//
// BYOA: credentials are per-business, stored in BusinessChannelCredential and
// loaded via loadPedidosYaCredentials(businessId). The PEDIDOSYA_API_TOKEN env
// var is a global fallback only. PedidosYa is gated in resolveActiveCouriers so
// it only participates for businesses that have actually connected an account.
//
// quote  → POST /v3/shippings/estimates       (via pedidosya-api-client.ts)
// create → POST /v3/shippings                  (via pedidosya-api-client.ts)
// track  → GET  /v3/shippings/{id}(+/tracking) (via pedidosya-api-client.ts)
//
// PedidosYa is a same-city last-mile courier (express/scheduled), NOT
// inter-city parcel mail. Waypoints require addresses or lat/lon.
//
// Graceful degradation:
//   Missing credentials → empty options (quote) / JSON-RPC error (create/track)
//   so compare_rates omits PedidosYa without crashing the fan-out.
//   Network failures → empty options (quote) or JSON-RPC error (create/track).
//
// Split modules:
//   pedidosya-types.ts      — TypeScript interfaces
//   pedidosya-mock.ts       — isPedidosYaMockEnabled + mock data helpers
//   pedidosya-api-client.ts — real fetch calls (estimates, shippings, tracking)

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { loadPedidosYaCredentials } from "@/infrastructure/messaging/messaging-credential-loader";
import {
  isPedidosYaMockEnabled,
  mockPedidosYaQuote,
  mockPedidosYaCreate,
  mockPedidosYaTrack,
} from "./pedidosya-mock";
import {
  envPedidosYaToken,
  fetchPedidosYaEstimate,
  fetchPedidosYaCreate,
  fetchPedidosYaTrack,
} from "./pedidosya-api-client";
import type { PedidosYaQuoteResult } from "./pedidosya-types";
import type { ProviderAdapter, JsonRpcResponse } from "../logistica-provider";

/**
 * Resolve the PedidosYa API token for a business (BYOA-first).
 * Order: per-business BusinessChannelCredential → PEDIDOSYA_API_TOKEN env fallback.
 * Returns null when neither is configured (caller fails-closed). Tenant-scoped.
 */
async function resolvePedidosYaToken(businessId: string): Promise<string | null> {
  const creds = await loadPedidosYaCredentials(businessId);
  if (creds?.apiToken) return creds.apiToken;
  const envToken = envPedidosYaToken();
  return envToken.length > 0 ? envToken : null;
}

export { isPedidosYaMockEnabled, isPedidosYaMockActive } from "./pedidosya-mock";

// ── Helpers ───────────────────────────────────────────────────────────────────

function pyaResult(skill: string, data: unknown): JsonRpcResponse {
  const callId = randomUUID();
  return {
    jsonrpc: "2.0",
    id: callId,
    result: {
      kind: "message",
      messageId: randomUUID(),
      role: "agent",
      contextId: callId,
      skill,
      parts: [{ kind: "text" as const, text: JSON.stringify(data) }],
      result: data,
    },
  };
}

function pyaError(code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

const NO_CREDS_MSG = "PedidosYa no configurado para este negocio. Activá tu cuenta en Configuración → Logística.";

// ── PedidosYaAdapter ──────────────────────────────────────────────────────────

export class PedidosYaAdapter implements ProviderAdapter {
  /**
   * Estimate PedidosYa shipping price via POST /v3/estimate.
   * Returns empty options (not an error) on failures so compare_rates remains stable.
   */
  async quote(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const origin = str(params, "originPostalCode");
    const dest   = str(params, "destinationPostalCode");
    try {
      const mock = isPedidosYaMockEnabled();
      cloudLog({
        severity: "INFO", component: "A2A", action: "LOGISTICA_PEDIDOSYA_QUOTE",
        a2a_transfer: false,
        message: `PedidosYaAdapter.quote: origin=${origin} dest=${dest}`,
        data: { businessId, mock },
      });
      if (mock) return pyaResult("shipment.quote", mockPedidosYaQuote(origin, dest));

      const token = await resolvePedidosYaToken(businessId);
      if (!token) {
        cloudLog({
          severity: "WARNING", component: "A2A", action: "PEDIDOSYA_NO_CREDENTIALS",
          a2a_transfer: false, message: "PedidosYa quote skipped — no BYOA credential for this business",
          data: { businessId },
        });
        const empty: PedidosYaQuoteResult = { originPostalCode: origin, destinationPostalCode: dest, provider: "pedidosya", options: [] };
        return pyaResult("shipment.quote", empty);
      }

      const result = await fetchPedidosYaEstimate(token, params, origin, dest);
      return pyaResult("shipment.quote", result);
    } catch (err) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "LOGISTICA_PEDIDOSYA_QUOTE_FAILED",
        a2a_transfer: false,
        message: `PedidosYaAdapter.quote failed for businessId=${businessId}`,
        data: { businessId, error: err instanceof Error ? err.message : String(err) },
      });
      const empty: PedidosYaQuoteResult = { originPostalCode: origin, destinationPostalCode: dest, provider: "pedidosya", options: [] };
      return pyaResult("shipment.quote", empty);
    }
  }

  /**
   * Create a PedidosYa delivery order via POST /v3/orders.
   * Returns orderId as trackingNumber (no label PDF in v3).
   */
  async create(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const saleId = str(params, "saleId");
    if (!saleId) return pyaError(-32602, "saleId is required for PedidosYa shipment.create");

    const customer = (params.customer && typeof params.customer === "object" && !Array.isArray(params.customer))
      ? (params.customer as Record<string, unknown>)
      : {};
    try {
      const mock = isPedidosYaMockEnabled();
      cloudLog({
        severity: "INFO", component: "A2A", action: "LOGISTICA_PEDIDOSYA_CREATE",
        a2a_transfer: false,
        message: `PedidosYaAdapter.create: saleId=${saleId}`,
        data: { businessId, saleId, mock },
      });
      if (mock) return pyaResult("shipment.create", mockPedidosYaCreate(saleId, businessId));
      const token = await resolvePedidosYaToken(businessId);
      if (!token) return pyaError(-32603, NO_CREDS_MSG);

      const result = await fetchPedidosYaCreate(token, params, customer, saleId);
      return pyaResult("shipment.create", result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido al crear envío PedidosYa";
      cloudLog({
        severity: "ERROR", component: "A2A", action: "LOGISTICA_PEDIDOSYA_CREATE_FAILED",
        a2a_transfer: false, message: `PedidosYaAdapter.create failed: ${msg}`,
        data: { businessId, saleId },
      });
      return pyaError(-32603, `PedidosYa: ${msg}`);
    }
  }

  /**
   * Track a PedidosYa order via GET /v3/orders/{orderId}.
   * trackingNumber = orderId returned by create().
   */
  async track(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const trackingNumber = str(params, "trackingNumber");
    if (!trackingNumber) return pyaError(-32602, "trackingNumber is required for PedidosYa shipment.track");

    try {
      const mock = isPedidosYaMockEnabled();
      cloudLog({
        severity: "INFO", component: "A2A", action: "LOGISTICA_PEDIDOSYA_TRACK",
        a2a_transfer: false, message: `PedidosYaAdapter.track: orderId=${trackingNumber}`,
        data: { businessId, trackingNumber, mock },
      });
      if (mock) return pyaResult("shipment.track", mockPedidosYaTrack(trackingNumber));
      const token = await resolvePedidosYaToken(businessId);
      if (!token) return pyaError(-32603, NO_CREDS_MSG);

      const result = await fetchPedidosYaTrack(token, trackingNumber);
      return pyaResult("shipment.track", result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido al rastrear envío PedidosYa";
      cloudLog({
        severity: "WARNING", component: "A2A", action: "LOGISTICA_PEDIDOSYA_TRACK_FAILED",
        a2a_transfer: false,
        message: `PedidosYaAdapter.track failed for trackingNumber=${trackingNumber}`,
        data: { businessId, trackingNumber, error: msg },
      });
      return pyaError(-32603, `PedidosYa: no se pudo obtener el seguimiento. ${msg}`);
    }
  }
}
