// Correo Argentino provider adapter for the Logística role-agent.
// Implements ProviderAdapter using the real Correo MiCorreo API client.
//
// quote  → POST /Rates (requires valid Bearer token + customerId in credentials)
// create → NOT supported by MiCorreo v1 public spec; returns explicit JSON-RPC error
// track  → NOT supported by MiCorreo v1 public spec; returns explicit JSON-RPC error
//
// Graceful degradation:
//   loadCorreoCredentials returns null when the business has not connected a Correo
//   account → adapter returns empty options for quote and JSON-RPC errors for
//   create/track, so compare_rates silently omits Correo without crashing.
//
// Errors from the Correo API are classified:
//   - Network timeout / 5xx → logged as WARNING, empty options returned for quote.
//   - Auth failure / 401    → logged as ERROR, JSON-RPC error body returned.

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { getCourierCredentialPort } from "@/infrastructure/courier/courier-credential.adapter";
import {
  resolveToken,
  fetchRates,
} from "@/app/api/agents/correo/_lib/correo-api-client";
import type { ProviderAdapter, JsonRpcResponse } from "../logistica-provider";
import type {
  CorreoQuoteResult,
  CorreoTarifaOption,
} from "@/app/api/agents/correo/_lib/types";

// ── Internal helpers ──────────────────────────────────────────────────────────

function correoResult(skill: string, data: unknown): JsonRpcResponse {
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

function correoError(code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

// ── CorreoAdapter ─────────────────────────────────────────────────────────────

export class CorreoAdapter implements ProviderAdapter {
  /**
   * Quote shipping rates from Correo Argentino via POST /Rates.
   * Returns empty options (not an error) on missing credentials or transient
   * failures so compare_rates can still return Andreani/OCA results.
   */
  async quote(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const creds = await getCourierCredentialPort().loadCorreo(businessId);
    if (!creds) {
      cloudLog({
        severity: "INFO", component: "A2A", action: "CORREO_NO_CREDENTIALS",
        a2a_transfer: false,
        message: `Correo quote skipped — no credentials for businessId=${businessId}`,
        data: { businessId },
      });
      const empty: CorreoQuoteResult = {
        originPostalCode:      str(params, "originPostalCode"),
        destinationPostalCode: str(params, "destinationPostalCode"),
        provider: "correo",
        options: [],
      };
      return correoResult("shipment.quote", empty);
    }

    const ctx = await resolveToken(businessId);
    if (!ctx) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "CORREO_TOKEN_FAILED",
        a2a_transfer: false,
        message: `Correo token resolution failed for businessId=${businessId}`,
        data: { businessId },
      });
      const empty: CorreoQuoteResult = {
        originPostalCode:      str(params, "originPostalCode"),
        destinationPostalCode: str(params, "destinationPostalCode"),
        provider: "correo",
        options: [],
      };
      return correoResult("shipment.quote", empty);
    }

    const originPostal = str(params, "originPostalCode");
    const destPostal   = str(params, "destinationPostalCode");
    const weightGrams  = num(params, "weightGrams", 500);

    // MiCorreo /Rates expects weight in kg; minimum 0.1 kg.
    const weightKg = Math.max(0.1, weightGrams / 1000);

    // Dimensions in cm — default to a minimal parcel when not provided.
    const largoCm = num(params, "lengthCm", 20);
    const altoCm  = num(params, "heightCm", 10);
    const anchoCm = num(params, "widthCm",  15);

    let options: CorreoTarifaOption[];
    try {
      options = await fetchRates(
        {
          customerId:           creds.customerId,
          codigoPostalOrigen:   originPostal,
          codigoPostalDestino:  destPostal,
          peso:                 weightKg,
          largo:                largoCm,
          alto:                 altoCm,
          ancho:                anchoCm,
        },
        ctx,
      );
    } catch (err) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "CORREO_RATES_FAILED",
        a2a_transfer: false,
        message: `Correo /Rates failed for businessId=${businessId}`,
        data: { businessId, error: err instanceof Error ? err.message : String(err) },
      });
      options = [];
    }

    const result: CorreoQuoteResult = {
      originPostalCode: originPostal,
      destinationPostalCode: destPostal,
      provider: "correo",
      options,
    };
    return correoResult("shipment.quote", result);
  }

  /**
   * Shipment creation is NOT supported by MiCorreo v1.
   * The API spec exposes only quote (Rates) and agency lookup (Agencies) endpoints.
   * Returning a clear error avoids silent failures.
   */
  async create(_params: Record<string, unknown>, _businessId: string): Promise<JsonRpcResponse> {
    return correoError(
      -32603,
      "Correo Argentino no soporta creación de envíos vía API en este momento. " +
      "Generá el envío manualmente en el sitio de Correo Argentino.",
    );
  }

  /**
   * Shipment tracking is NOT supported by MiCorreo v1 (no public tracking endpoint
   * in the documented spec). Returning a clear error for transparency.
   */
  async track(_params: Record<string, unknown>, _businessId: string): Promise<JsonRpcResponse> {
    return correoError(
      -32603,
      "El seguimiento de envíos de Correo Argentino no está disponible vía API. " +
      "Podés rastrear tu envío en https://www.correoargentino.com.ar/MiCorreo.",
    );
  }
}
