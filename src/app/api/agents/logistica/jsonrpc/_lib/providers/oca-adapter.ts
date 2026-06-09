// OCA provider adapter for the Logística role-agent.
// Implements ProviderAdapter using the real OCA API client.
//
// quote  → OCA e-Pak Tarifar_Envio_Corporativo (tarifa XML endpoint)
// create → OCA e-Pak IngresoORMultiplesRetiros (order creation + label URL)
// track  → OCA ApiPostal EstadoActual + HistorialSeguimiento (bearer token)
//
// Graceful degradation:
//   loadOcaCredentials returns null when the business has not connected an OCA
//   account → adapter returns a JSON-RPC error result (not a throw) so compare_rates
//   can silently omit OCA without crashing the fan-out.
//
// Errors from the OCA API are classified:
//   - Network timeout / 5xx → logged as WARNING, empty options returned for quote.
//   - Auth failure / 401    → logged as ERROR, JSON-RPC error body returned.

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { getCourierCredentialPort } from "@/infrastructure/courier/courier-credential.adapter";
import {
  resolveToken,
  fetchTarifas,
  crearEnvio,
  fetchEstadoActual,
  fetchHistorialSeguimiento,
} from "@/app/api/agents/oca/_lib/oca-api-client";
import { runWithOcaCircuit, isOcaCircuitOpen } from "./oca-circuit";
import { ocaResult, ocaError, str, num, persistOcaShipment } from "./oca-adapter-helpers";
import type { ProviderAdapter, JsonRpcResponse } from "../logistica-provider";
import type { OcaQuoteResult, OcaCreateResult, OcaTrackResult, OcaTarifaOption } from "@/app/api/agents/oca/_lib/types";

// ── OcaAdapter ────────────────────────────────────────────────────────────────

export class OcaAdapter implements ProviderAdapter {
  /**
   * Quote shipping rates from OCA via Tarifar_Envio_Corporativo.
   * Returns options array in the canonical shape parseable by extractCheapestPrice.
   * Returns empty options (not an error) on transient OCA failures so compare_rates
   * can still return Andreani results.
   */
  async quote(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const creds = await getCourierCredentialPort().loadOca(businessId);
    if (!creds) {
      cloudLog({
        severity: "INFO", component: "A2A", action: "OCA_NO_CREDENTIALS",
        a2a_transfer: false, message: `OCA quote skipped — no credentials for businessId=${businessId}`,
        data: { businessId },
      });
      // Return empty options so compare_rates omits OCA silently.
      const empty: OcaQuoteResult = {
        originPostalCode:      str(params, "originPostalCode"),
        destinationPostalCode: str(params, "destinationPostalCode"),
        provider: "oca",
        options:  [],
      };
      return ocaResult("shipment.quote", empty);
    }

    const originPostal = str(params, "originPostalCode");
    const destPostal   = str(params, "destinationPostalCode");
    const weightGrams  = num(params, "weightGrams",  500);
    const declaredVal  = num(params, "declaredValue", 0);

    // e-Pak expects kg (minimum 0.1 kg).
    const weightKg = Math.max(0.1, weightGrams / 1000);
    // Volume: OCA requires m³; default to minimal 0.001 m³ when not provided.
    const volumeM3 = num(params, "volumeM3", 0.001);

    let options: OcaTarifaOption[];
    try {
      const tarifaResult = await runWithOcaCircuit(() => fetchTarifas({
        cuit:          creds.cuit,
        operativa:     creds.operativa,
        originPostal,
        destPostal,
        weightKg,
        volumeM3,
        packages:      1,
        declaredValue: declaredVal,
        usuario:       creds.usuario,
        password:      creds.password,
      }));
      if (isOcaCircuitOpen(tarifaResult)) {
        cloudLog({
          severity: "WARNING", component: "A2A", action: "OCA_TARIFA_CIRCUIT_SKIP",
          a2a_transfer: false,
          message: `OCA quote skipped — circuit OPEN — businessId=${businessId}`,
          data: { businessId, reason: tarifaResult.message },
        });
        options = [] as OcaTarifaOption[];
      } else {
        options = tarifaResult;
      }
    } catch (err) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "OCA_TARIFA_FAILED",
        a2a_transfer: false,
        message: `OCA Tarifar_Envio_Corporativo failed for businessId=${businessId}`,
        data: { businessId, error: err instanceof Error ? err.message : String(err) },
      });
      options = [] as OcaTarifaOption[];
    }

    const result: OcaQuoteResult = {
      originPostalCode: originPostal,
      destinationPostalCode: destPostal,
      provider: "oca",
      options,
    };
    return ocaResult("shipment.quote", result);
  }

  /**
   * Create a shipment via OCA e-Pak IngresoORMultiplesRetiros.
   * Pre-call dedup: checks OcaShipment for (saleId, businessId) BEFORE calling OCA
   * to prevent duplicate labels + double billing on retries.
   */
  async create(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const creds = await getCourierCredentialPort().loadOca(businessId);
    if (!creds) {
      return ocaError(-32603, `OCA no configurado para este negocio. Conectá tu cuenta OCA en Configuración → Logística.`);
    }

    // saleId required — without it dedup is impossible (mirrors Andreani guard).
    const saleId = str(params, "saleId");
    if (!saleId) {
      return ocaError(-32602, "saleId is required for OCA shipment.create");
    }

    const existing = await prisma.ocaShipment.findFirst({
      where: { saleId, businessId },
      select: { trackingNumber: true, service: true, labelUrl: true },
    });
    if (existing) {
      cloudLog({
        severity: "INFO", component: "A2A", action: "OCA_CREATE_DEDUP_HIT",
        a2a_transfer: false,
        message: `OCA create dedup hit — returning cached tracking for saleId=${saleId}`,
        data: { businessId, saleId, trackingNumber: existing.trackingNumber },
      });
      const cached: OcaCreateResult = {
        saleId,
        trackingNumber: existing.trackingNumber,
        labelUrl:       existing.labelUrl,
        estimatedDelivery: null,
        service:        existing.service,
        provider:       "oca",
      };
      return ocaResult("shipment.create", cached);
    }

    // Customer address from params.
    const customer = (params.customer && typeof params.customer === "object" && !Array.isArray(params.customer))
      ? params.customer as Record<string, unknown>
      : {};

    // postalCode required — "0000" causes a cryptic OCA API rejection (mirrors Andreani C-3 fix).
    if (!str(customer, "postalCode")) {
      return ocaError(-32602, "Código postal de destino requerido.");
    }

    const weightGrams = num(params, "weightGrams", 500);

    let result: OcaCreateResult;
    try {
      const crearResult = await runWithOcaCircuit(() => crearEnvio({
        usuario:             creds.usuario,
        password:            creds.password,
        nroCuenta:           creds.nroCuenta,
        operativa:           creds.operativa,
        saleId,
        recipientName:       str(customer, "name")          || "Sin nombre",
        recipientLastName:   str(customer, "lastName")      || undefined,
        recipientAddr:       str(customer, "address")       || "Sin dirección",
        recipientAddrNumber: str(customer, "addressNumber") || "",
        recipientPostal:     str(customer, "postalCode"),
        recipientCity:       str(customer, "city")          || "",
        recipientProvince:   str(customer, "province")      || "",
        recipientPhone:      str(customer, "phone")         || "",
        weightKg:            Math.max(0.1, weightGrams / 1000),
        heightCm:            num(params, "heightCm", 10),
        widthCm:             num(params, "widthCm",  10),
        lengthCm:            num(params, "lengthCm", 10),
      }));
      if (isOcaCircuitOpen(crearResult)) {
        cloudLog({
          severity: "WARNING", component: "A2A", action: "OCA_CREATE_CIRCUIT_SKIP",
          a2a_transfer: false,
          message: `OCA create skipped — circuit OPEN — businessId=${businessId} saleId=${saleId}`,
          data: { businessId, saleId, reason: crearResult.message },
        });
        return ocaError(-32603, crearResult.message);
      }
      result = crearResult;
    } catch (err) {
      cloudLog({
        severity: "ERROR", component: "A2A", action: "OCA_CREATE_FAILED",
        a2a_transfer: false,
        message: `OCA IngresoORMultiplesRetiros failed for businessId=${businessId}`,
        data: { businessId, saleId, error: err instanceof Error ? err.message : String(err) },
      });
      return ocaError(-32603, `OCA: no se pudo crear el envío. ${err instanceof Error ? err.message : "Error desconocido."}`);
    }

    // Atomic insert — mirrors Andreani fleet standard (create + P2002 catch).
    // persistOcaShipment returns the winning row on race, null on happy path / non-P2002 fail.
    const raceRow = await persistOcaShipment(result, businessId, creds.operativa);
    if (raceRow) return ocaResult("shipment.create", raceRow);

    return ocaResult("shipment.create", result);
  }

  /**
   * Track a shipment via OCA ApiPostal EstadoActual + HistorialSeguimiento.
   * Requires a valid ApiPostal bearer token (loginSigma).
   */
  async track(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse> {
    const trackingNumber = str(params, "trackingNumber");
    if (!trackingNumber) {
      return ocaError(-32602, "trackingNumber is required for OCA track");
    }

    const ctx = await resolveToken(businessId);
    if (!ctx) {
      return ocaError(-32603, `OCA no configurado para este negocio. Conectá tu cuenta OCA en Configuración → Logística.`);
    }

    let status = "unknown";
    let events: OcaTrackResult["events"] = [];

    try {
      const trackResult = await runWithOcaCircuit(() => Promise.all([
        fetchEstadoActual(trackingNumber, ctx),
        fetchHistorialSeguimiento(trackingNumber, ctx),
      ]));
      if (isOcaCircuitOpen(trackResult)) {
        cloudLog({
          severity: "WARNING", component: "A2A", action: "OCA_TRACK_CIRCUIT_SKIP",
          a2a_transfer: false,
          message: `OCA track skipped — circuit OPEN — trackingNumber=${trackingNumber}`,
          data: { businessId, trackingNumber, reason: trackResult.message },
        });
        return ocaError(-32603, trackResult.message);
      }
      const [estadoResp, historialResp] = trackResult;

      if (estadoResp.success && estadoResp.result) {
        status = estadoResp.result.descripcionEstado ?? estadoResp.result.estado ?? "en tránsito";
      }

      if (historialResp.success && Array.isArray(historialResp.result)) {
        events = historialResp.result.map((item) => ({
          timestamp:   item.fechaEvento   ?? new Date().toISOString(),
          description: item.descripcionEstado ?? item.estado ?? "Evento OCA",
          location:    item.sucursal,
        }));
      }
    } catch (err) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "OCA_TRACK_FAILED",
        a2a_transfer: false,
        message: `OCA tracking failed for trackingNumber=${trackingNumber}`,
        data: { businessId, trackingNumber, error: err instanceof Error ? err.message : String(err) },
      });
      return ocaError(-32603, `OCA: no se pudo obtener el seguimiento. ${err instanceof Error ? err.message : "Error desconocido."}`);
    }

    const result: OcaTrackResult = { trackingNumber, provider: "oca", status, events };
    return ocaResult("shipment.track", result);
  }
}
