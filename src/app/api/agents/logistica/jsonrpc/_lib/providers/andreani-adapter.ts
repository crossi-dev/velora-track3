// Andreani provider adapter for the Logística role-agent.
// In-process implementation — calls the Andreani _lib helpers directly,
// mirroring the OcaAdapter pattern (no HTTP fan-out to a peer agent).
//
// quote  → shipmentQuote  (shipment-quote.ts)
// create → shipmentCreate (shipment-create.ts)
// track  → shipmentTrack  (shipment-track.ts)
//
// Mock mode: delegated to isAndreaniMockActive(businessId) + mock* helpers in andreani-mock.ts.
// Graceful degradation: missing credentials surface as a JSON-RPC error so
// compare_rates can omit Andreani without crashing the fan-out.

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { shipmentQuote } from "@/app/api/agents/andreani/_lib/shipment-quote";
import { shipmentCreate } from "@/app/api/agents/andreani/_lib/shipment-create";
import { shipmentTrack } from "@/app/api/agents/andreani/_lib/shipment-track";
import {
  isAndreaniMockActive,
  mockShipmentQuote,
  mockShipmentCreate,
  mockShipmentTrack,
} from "@/app/api/agents/andreani/_lib/andreani-mock";
import type { QuoteInput, CreateShipmentInput, TrackInput } from "@/app/api/agents/andreani/_lib/types";
import type { ProviderAdapter, JsonRpcResponse } from "../logistica-provider";
import { isCircuitOpen, recordSuccess, recordFailure } from "./andreani-circuit";

// ── Internal helpers ──────────────────────────────────────────────────────────

// JSON-RPC 2.0 spec §5: "id" in the response MUST equal the "id" in the request.
function andreaniResult(skill: string, data: unknown, requestId?: string | number | null): JsonRpcResponse {
  const callId = requestId !== undefined && requestId !== null ? String(requestId) : randomUUID();
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

function andreaniError(code: number, message: string): JsonRpcResponse {
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

// Argentine postal codes: 4 digits (legacy format) or 5 digits (enhanced CPs).
// Schema description says 4-5 digits; widen from /^\d{4}$/ to match both.
const CP_REGEX = /^\d{4,5}$/;

// ── AndreaniAdapter ───────────────────────────────────────────────────────────
// Circuit breaker state (REL-N-6: quote + create + track) lives in andreani-circuit.ts.

export class AndreaniAdapter implements ProviderAdapter {
  /**
   * Quote Andreani shipping rates.
   * Returns options array in the canonical shape parseable by extractCheapestPrice.
   * Returns empty options (not an error) on transient failures so compare_rates
   * can still return OCA/Correo results.
   */
  async quote(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const requestId = params.id as string | number | null | undefined;
    const originPostalCode = str(params, "originPostalCode");
    const destinationPostalCode = str(params, "destinationPostalCode");

    if (!originPostalCode || !destinationPostalCode) {
      return andreaniError(
        -32602,
        "originPostalCode and destinationPostalCode are required for Andreani quote",
      );
    }

    if (!CP_REGEX.test(originPostalCode) || !CP_REGEX.test(destinationPostalCode)) {
      return andreaniError(-32602, "postalCode inválido — debe ser un código postal argentino de 4 o 5 dígitos");
    }

    const input: QuoteInput = {
      originPostalCode,
      destinationPostalCode,
      weightGrams: num(params, "weightGrams", 500),
      declaredValue: num(params, "declaredValue", 0),
    };

    // Circuit breaker: if Andreani has been failing repeatedly, return empty
    // options immediately so compare_rates can still return OCA/Correo results.
    if (await isCircuitOpen()) {
      cloudLog({
        severity: "INFO",
        component: "A2A",
        action: "LOGISTICA_ANDREANI_CIRCUIT_SKIP",
        a2a_transfer: false,
        message: "Andreani circuit OPEN — skipping quote, returning empty options",
        data: { businessId },
      });
      return andreaniResult("shipment.quote", { options: [], originPostalCode, destinationPostalCode }, requestId);
    }

    try {
      // isAndreaniMockActive(businessId) is non-throwing and per-business:
      // mock applies only to demo businesses even when ANDREANI_MOCK_MODE=true globally.
      const mock = isAndreaniMockActive(businessId);
      // Log mock-vs-real at adapter entry so every request is unambiguous in logs.
      cloudLog({
        severity: "INFO",
        component: "A2A",
        action: "LOGISTICA_ANDREANI_QUOTE",
        a2a_transfer: false,
        message: `AndreaniAdapter.quote: origin=${originPostalCode} dest=${destinationPostalCode}`,
        data: { businessId, weightGrams: input.weightGrams, mock },
      });
      const result = mock
        ? mockShipmentQuote(input)
        : await shipmentQuote(input, businessId);

      recordSuccess();
      return andreaniResult("shipment.quote", result, requestId);
    } catch (err) {
      recordFailure("quote");
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "LOGISTICA_ANDREANI_QUOTE_FAILED",
        a2a_transfer: false,
        message: `AndreaniAdapter.quote failed for businessId=${businessId}`,
        data: { businessId, error: err instanceof Error ? err.message : String(err) },
      });
      // Return empty options so compare_rates omits Andreani silently.
      return andreaniResult("shipment.quote", {
        options: [],
        originPostalCode,
        destinationPostalCode,
      }, requestId);
    }
  }

  /**
   * Create an Andreani shipment order.
   */
  async create(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const requestId = params.id as string | number | null | undefined;
    const saleId = str(params, "saleId");
    if (!saleId) {
      return andreaniError(-32602, "saleId is required for Andreani shipment.create");
    }

    const customer =
      params.customer && typeof params.customer === "object" && !Array.isArray(params.customer)
        ? (params.customer as Record<string, unknown>)
        : {};

    const serviceRaw = str(params, "service");
    const service: CreateShipmentInput["service"] =
      serviceRaw === "sucursal" || serviceRaw === "express" ? serviceRaw : "domicilio";

    const postalCode = str(customer, "postalCode");
    // postalCode is required — defaulting to "0000" causes an opaque Andreani API
    // rejection. Surface the error here with a clear message instead.
    if (!postalCode) {
      return andreaniError(-32602, "Código postal de destino requerido.");
    }
    if (!CP_REGEX.test(postalCode)) {
      return andreaniError(-32602, "postalCode inválido — debe ser un código postal argentino de 4 o 5 dígitos");
    }

    const input: CreateShipmentInput = {
      saleId,
      customer: {
        name: str(customer, "name") || "Sin nombre",
        address: str(customer, "address") || "Sin dirección",
        postalCode,
        phone: str(customer, "phone") || "",
        dni: str(customer, "dni") || null,
      },
      service,
      weightGrams: num(params, "weightGrams", 500),
    };

    if (await isCircuitOpen()) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "LOGISTICA_ANDREANI_CIRCUIT_SKIP",
        a2a_transfer: false,
        message: "Andreani circuit OPEN — skipping create",
        data: { businessId, saleId },
      });
      return andreaniError(-32603, "Andreani temporalmente no disponible — intentá en 1 minuto");
    }

    try {
      // isAndreaniMockActive(businessId) is non-throwing and per-business:
      // mock applies only to demo businesses even when ANDREANI_MOCK_MODE=true globally.
      const mock = isAndreaniMockActive(businessId);
      const result = mock
        ? await mockShipmentCreate(input, businessId)
        : await shipmentCreate(input, businessId);

      recordSuccess();
      cloudLog({
        severity: "INFO",
        component: "A2A",
        action: "LOGISTICA_ANDREANI_CREATE",
        a2a_transfer: false,
        message: `AndreaniAdapter.create: saleId=${saleId}`,
        data: { businessId, saleId, mock },
      });

      return andreaniResult("shipment.create", result, requestId);
    } catch (err) {
      recordFailure("create");
      const msg = err instanceof Error ? err.message : "Error desconocido al crear envío Andreani";
      cloudLog({
        severity: "ERROR",
        component: "A2A",
        action: "LOGISTICA_ANDREANI_CREATE_FAILED",
        a2a_transfer: false,
        message: `AndreaniAdapter.create failed: ${msg}`,
        data: { businessId, saleId },
      });
      return andreaniError(-32603, `Andreani: ${msg}`);
    }
  }

  /**
   * Track an Andreani shipment by tracking number.
   */
  async track(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const requestId = params.id as string | number | null | undefined;
    const trackingNumber = str(params, "trackingNumber");
    if (!trackingNumber) {
      return andreaniError(-32602, "trackingNumber is required for Andreani shipment.track");
    }

    const input: TrackInput = { trackingNumber };

    if (await isCircuitOpen()) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "LOGISTICA_ANDREANI_CIRCUIT_SKIP",
        a2a_transfer: false,
        message: "Andreani circuit OPEN — skipping track",
        data: { businessId, trackingNumber },
      });
      return andreaniError(-32603, "Andreani temporalmente no disponible — intentá en 1 minuto");
    }

    try {
      // isAndreaniMockActive(businessId) is non-throwing and per-business:
      // mock applies only to demo businesses even when ANDREANI_MOCK_MODE=true globally.
      const mock = isAndreaniMockActive(businessId);
      const result = mock
        ? mockShipmentTrack(input)
        : await shipmentTrack(input, businessId);

      recordSuccess();
      cloudLog({
        severity: "INFO",
        component: "A2A",
        action: "LOGISTICA_ANDREANI_TRACK",
        a2a_transfer: false,
        message: `AndreaniAdapter.track: tracking=${trackingNumber}`,
        data: { businessId, trackingNumber, mock },
      });

      return andreaniResult("shipment.track", result, requestId);
    } catch (err) {
      recordFailure("track");
      const msg = err instanceof Error ? err.message : "Error desconocido al rastrear envío Andreani";
      cloudLog({
        severity: "ERROR",
        component: "A2A",
        action: "LOGISTICA_ANDREANI_TRACK_FAILED",
        a2a_transfer: false,
        message: `AndreaniAdapter.track failed: ${msg}`,
        data: { businessId, trackingNumber },
      });
      return andreaniError(-32603, `Andreani: ${msg}`);
    }
  }
}
