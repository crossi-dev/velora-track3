// Logística tool — logistica.rastrear_envio
// Routes the tracking request to the adapter for the given courier provider.
// No single courier is hardcoded here — the caller passes the provider slug.
//
// Interface reshape (feat/logistica-tools): tool is now registered under the
// canonical "logistica.rastrear_envio" namespace via createTool factory.
// Market shape source: OCA API https://developers.oca.com.ar/apiocageo.html
//   Fields: numeroEnvio → trackingNumber, courier slug → provider.
//
// SECURITY: businessId is closure-bound from the trusted ctx at agent creation time.
// The LLM-supplied businessId field in the schema is retained for prompt legibility
// but is NEVER used in execute() — the closure value is always authoritative.
//
// HISTORICAL TRACKING: provider accepts any registered courier slug (not just active ones)
// so owners can track pre-shelved OCA/Correo shipments. Runtime validation via
// getCourierEntry rejects truly unknown slugs with a structured error.
//
// Backend routing (AGENT_LOGISTICA_BACKEND, separate from LOGISTICA_BACKEND MCP flag):
//   Unset / blank → LEGACY: getCourierEntry() called directly from courier-registry.
//   Set            → route getCourierEntryForTrack through createLogisticaBackend().
//   backendOverride (toolCtx) → test injection, bypasses flag entirely.
// Provider adapter.track() call stays in this tool — tool-layer logic.

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "@/lib/adk/tools/_shared/create-tool";
import { cloudLog } from "@/lib/cloud-logger";
import { getCourierEntry } from "../courier-registry";
import type { LogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.port";
import { createLogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.factory";

// ── Zod input schema (runtime validation via createTool) ──────────────────────

const trackShipmentParams = z.object({
  businessId: z.string().describe("Velora Business ID — resolución de credenciales por tenant."),
  provider: z
    .string()
    .describe(
      "Courier que creó el envío. Slug usado en logistica.crear_etiqueta. " +
      "Ejemplos: 'andreani', 'oca', 'correo'.",
    ),
  trackingNumber: z
    .string()
    .describe("Número de tracking devuelto por el courier al crear el envío (numeroEnvio en OCA API)."),
});

// ── Genai schema (LLM calling convention — separate from Zod validation) ──────

const RASTREAR_ENVIO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    businessId: {
      type: Type.STRING,
      description: "Velora Business ID — resolución de credenciales por tenant.",
    },
    provider: {
      type: Type.STRING,
      description:
        "Courier que creó el envío. Slug usado en logistica.crear_etiqueta. " +
        "Ejemplos: 'andreani', 'oca', 'correo'.",
    },
    trackingNumber: {
      type: Type.STRING,
      description: "Número de tracking devuelto por el courier al crear el envío.",
    },
  },
  required: ["businessId", "provider", "trackingNumber"],
};

/** Tool-scoped context for backend injection (mirrors EmitInvoiceToolContext pattern). */
export interface TrackShipmentToolCtx {
  /**
   * Optional LogisticaBackend injected for testing — bypasses both the
   * AGENT_LOGISTICA_BACKEND env flag and the legacy getCourierEntry path.
   * Default: null → falls through to flag-based routing.
   */
  backendOverride?: LogisticaBackend | null;
}

/**
 * Factory — closure-binds the trusted businessId so the LLM cannot override it.
 * Registers the tool as "logistica.rastrear_envio" via createTool factory.
 *
 * Routing (evaluated at call time — reads env at execute() time, not module-load):
 *   1. toolCtx.backendOverride present → use it (test injection, bypasses flag).
 *   2. AGENT_LOGISTICA_BACKEND set (non-blank) → route getCourierEntryForTrack through
 *      createLogisticaBackend() for per-tenant routing and non-Velora backend support.
 *   3. Unset / blank → legacy getCourierEntry() (byte-for-byte unchanged).
 *
 * Flag is intentionally SEPARATE from LOGISTICA_BACKEND (MCP path).
 * Provider adapter.track() call stays in this tool — tool-layer logic.
 */
export function createTrackShipmentTool(
  trustedBusinessId: string,
  toolCtx: TrackShipmentToolCtx = {},
) {
  return createTool({
    name: "logistica.rastrear_envio",
    description:
      "Rastrea el estado actual e historial de eventos de un envío por número de tracking. " +
      "Pasar el slug del courier usado al crear el envío para que se llame la API correcta.",
    schema: RASTREAR_ENVIO_SCHEMA,
    inputSchema: trackShipmentParams,
    backend: { trustedBusinessId, toolCtx },
    execute: async ({ input }) => {
      // businessId comes from the trusted closure — ignore whatever the LLM passed.
      const { provider, trackingNumber } = input;
      const businessId = trustedBusinessId;

      // ── Backend routing (read env at call time — not module-load) ────────────
      // Priority: backendOverride (test injection) > AGENT_LOGISTICA_BACKEND env > null (legacy).
      const agentLogisticaBackend = (process.env.AGENT_LOGISTICA_BACKEND ?? "").trim();
      const backend: LogisticaBackend | null =
        toolCtx.backendOverride ??
        (agentLogisticaBackend ? createLogisticaBackend(agentLogisticaBackend) : null);

      const courierEntry = backend
        ? (await backend.getCourierEntryForTrack({ tenantId: businessId, provider })).courierEntry
        : getCourierEntry(provider);
      if (!courierEntry) {
        return {
          error: {
            code: "UNKNOWN_PROVIDER",
            message: `Provider desconocido: '${provider}'. Valores válidos: 'andreani', 'oca', 'correo'.`,
          },
        };
      }

      cloudLog({
        severity: "INFO",
        component: "A2A",
        action: "LOGISTICA_TRACK_SHIPMENT",
        a2a_transfer: false,
        message: `logistica.rastrear_envio → ${courierEntry.name}: tracking=${trackingNumber}`,
        data: { businessId, trackingNumber, provider: courierEntry.name },
      });

      const adapter = courierEntry.getAdapter();
      const rpcResponse = await adapter.track({ trackingNumber }, businessId);

      if ("error" in rpcResponse) {
        const errMsg = rpcResponse.error.message;
        cloudLog({
          severity: "ERROR",
          component: "A2A",
          action: "LOGISTICA_TRACK_SHIPMENT_FAILED",
          a2a_transfer: false,
          message: errMsg,
          data: { businessId, trackingNumber, provider: courierEntry.name },
        });
        return { error: { code: "COURIER_ERROR", message: errMsg } };
      }

      const textPart = rpcResponse.result?.parts?.[0]?.text ?? "";
      return { success: true, provider: courierEntry.name, text: textPart };
    },
  });
}
