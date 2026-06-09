// Logística tool — logistica.cotizar_envio (feat/logistica-tools reshape)
// Fans out a shipment quote to every active courier and returns options ranked by price.
// Market shape: Enviopack cotizar https://developers.enviopack.com.ar/cotiza-un-envio
// SECURITY: businessId closure-bound — LLM-supplied field ignored in execute().
// Backend routing: backendOverride > createLogisticaBackend() (always via port — no inline prisma).

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "@/lib/adk/tools/_shared/create-tool";
import { cloudLog } from "@/lib/cloud-logger";
import type { CourierEntry } from "../courier-registry";
import type { LogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.port";
import { createLogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.factory";

const compareRatesParams = z.object({
  originPostalCode: z
    .string()
    .describe("Código postal de origen (cp_origen). 4-5 dígitos, sin letras. Requerido."),
  destinationPostalCode: z
    .string()
    .describe("Código postal de destino (cp_destino). 4-5 dígitos, sin letras. Requerido."),
  weightGrams: z
    .number()
    .describe("Peso total del envío en gramos (peso_gramos)."),
  declaredValue: z
    .number()
    .optional()
    .describe("Valor declarado en ARS para seguro (valor_declarado). Default: 0."),
  businessId: z
    .string()
    .describe("Velora Business ID — resolución de credenciales por tenant."),
});

const COTIZAR_ENVIO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    originPostalCode: {
      type: Type.STRING,
      description: "Código postal de origen (cp_origen). 4-5 dígitos, sin letras. Requerido.",
    },
    destinationPostalCode: {
      type: Type.STRING,
      description: "Código postal de destino (cp_destino). 4-5 dígitos, sin letras. Requerido.",
    },
    weightGrams: {
      type: Type.NUMBER,
      description: "Peso total del envío en gramos (peso_gramos).",
    },
    declaredValue: {
      type: Type.NUMBER,
      description: "Valor declarado en ARS para seguro (valor_declarado). Default: 0.",
    },
    businessId: {
      type: Type.STRING,
      description: "Velora Business ID — resolución de credenciales por tenant.",
    },
  },
  required: ["originPostalCode", "destinationPostalCode", "weightGrams", "businessId"],
};

export interface CourierOption {
  provider: string;
  service: string;
  serviceLabel: string;
  priceARS: number;
  estimatedDays: number;
}

export interface RateComparisonResult {
  options: CourierOption[];
  cheapestPriceARS: number | null;
  originPostalCode: string;
  destinationPostalCode: string;
  weightGrams: number;
}

/** Tool-scoped context for backend injection (mirrors EmitInvoiceToolContext pattern). */
export interface CompareRatesToolCtx {
  /**
   * Optional LogisticaBackend injected for testing — bypasses both the
   * AGENT_LOGISTICA_BACKEND env flag and the legacy resolveActiveCouriers path.
   * Default: null → falls through to flag-based routing.
   */
  backendOverride?: LogisticaBackend | null;
}

// parseOptions expects `text` to be the JSON string serialised by the adapter's
// result.parts[0].text field. All adapters serialise QuoteResult ({ options: [...] })
// as JSON directly. If the shape changes, update the parsing logic here.
function parseOptions(
  text: string,
  providerName: string,
): CourierOption[] {
  try {
    const jsonStart = text.indexOf("{");
    if (jsonStart === -1) return [];
    const parsed = JSON.parse(text.slice(jsonStart)) as Record<string, unknown>;
    const items: Record<string, unknown>[] = Array.isArray(parsed.options)
      ? (parsed.options as Record<string, unknown>[])
      : Array.isArray(parsed.services)
        ? (parsed.services as Record<string, unknown>[])
        : [];
    return items
      .map((item) => {
        const priceARS =
          typeof item.priceARS === "number"
            ? item.priceARS
            : typeof item.price === "number"
              ? item.price
              : null;
        if (priceARS === null) return null;
        return {
          provider: providerName,
          service: typeof item.service === "string" ? item.service : providerName,
          serviceLabel:
            typeof item.serviceLabel === "string"
              ? item.serviceLabel
              : typeof item.service === "string"
                ? item.service
                : providerName,
          priceARS,
          estimatedDays:
            typeof item.estimatedDays === "number" ? item.estimatedDays : 0,
        } satisfies CourierOption;
      })
      .filter((o): o is CourierOption => o !== null);
  } catch {
    return [];
  }
}

/**
 * Factory — closure-binds the trusted businessId so the LLM cannot override it.
 * Registers the tool as "logistica.cotizar_envio" via createTool factory.
 *
 * Routing (evaluated at call time — reads env at execute() time, not module-load):
 *   1. toolCtx.backendOverride present → use it (test injection).
 *   2. Always delegates resolveActiveCouriers through createLogisticaBackend()
 *      (in-process port call — no inline Prisma). Tenant-scoped by businessId.
 *
 * Provider adapter.quote() calls remain in this tool — tool-layer logic.
 */
export function createCompareRatesTool(
  trustedBusinessId: string,
  toolCtx: CompareRatesToolCtx = {},
) {
  return createTool({
    name: "logistica.cotizar_envio",
    description:
      "Cotiza tarifas de envío en paralelo con todos los couriers activos (Andreani, OCA, Correo) " +
      "y devuelve opciones ordenadas de menor a mayor precio. " +
      "Usar antes de recomendar un courier — nunca elegir sin mostrar la comparativa.",
    schema: COTIZAR_ENVIO_SCHEMA,
    inputSchema: compareRatesParams,
    backend: { trustedBusinessId, toolCtx },
    execute: async ({ input }) => {
      // businessId comes from the trusted closure — ignore whatever the LLM passed.
      const {
        originPostalCode,
        destinationPostalCode,
        weightGrams,
        declaredValue,
      } = input;
      const businessId = trustedBusinessId;

      // ── Backend routing (always via port — no inline Prisma) ─────────────────
      // Priority: backendOverride (test injection) > createLogisticaBackend() default.
      // AGENT_LOGISTICA_BACKEND env var is forwarded inside createLogisticaBackend().
      const backend: LogisticaBackend =
        toolCtx.backendOverride ?? createLogisticaBackend();

      // Resolve active couriers via the port (in-process — tenant-scoped by businessId).
      const activeCouriers: CourierEntry[] = (await backend.resolveActiveCouriers({
        tenantId: businessId,
        originPostalCode,
        destinationPostalCode,
        weightGrams,
        declaredValue,
      })).activeCouriers;

      // Fan-out: parallel adapter calls to all active couriers.
      const quoteResults = await Promise.allSettled(
        activeCouriers.map(async (courier) => {
          cloudLog({
            severity: "INFO",
            component: "A2A",
            action: "LOGISTICA_RATE_COMPARE",
            a2a_transfer: false,
            message: `logistica.cotizar_envio → ${courier.name} (adapter): origin=${originPostalCode} dest=${destinationPostalCode}`,
            data: { courier: courier.name, businessId, weightGrams },
          });

          const adapter = courier.getAdapter();
          const rpcResponse = await adapter.quote(
            {
              originPostalCode,
              destinationPostalCode,
              weightGrams,
              declaredValue: declaredValue ?? 0,
            },
            businessId,
          );
          const result = (rpcResponse as { result?: { parts?: Array<{ text?: string }> } }).result;
          const textPart = result?.parts?.[0]?.text ?? "";
          return { courier: courier.name, text: textPart };
        }),
      );

      // Merge all options from settled results.
      const allOptions: CourierOption[] = [];
      for (const result of quoteResults) {
        if (result.status === "fulfilled") {
          const opts = parseOptions(result.value.text, result.value.courier);
          allOptions.push(...opts);
        } else {
          const err = result.reason;
          cloudLog({
            severity: "WARNING",
            component: "A2A",
            action: "LOGISTICA_RATE_COMPARE_COURIER_FAILED",
            a2a_transfer: false,
            message: `logistica.cotizar_envio: courier quote failed`,
            data: {
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      // Sort by price ascending — deterministic, not LLM-driven.
      allOptions.sort((a, b) => a.priceARS - b.priceARS);

      const cheapestPriceARS = allOptions.length > 0 ? allOptions[0].priceARS : null;

      return {
        options: allOptions,
        cheapestPriceARS,
        originPostalCode,
        destinationPostalCode,
        weightGrams,
      } satisfies RateComparisonResult;
    },
  });
}
