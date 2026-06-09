// Logística tool — logistica.seleccionar_courier
// Returns the package profile (weight, item count) for a given sale or list of
// product IDs — the pre-selection step before running logistica.cotizar_envio.
// When Product.weightGrams is set, uses real per-product weight
// (quantity × weightGrams). Falls back to 500 g/item for products with no weight.
// hasRealWeightData is true only when ALL items had a weightGrams value.
//
// Interface reshape (feat/logistica-tools): tool is now registered under the
// canonical "logistica.seleccionar_courier" namespace via createTool factory.
// This is the package-profiling/selection step: call it first to obtain the
// weight needed by logistica.cotizar_envio, then cotizar, then confirmar/crear_etiqueta.
//
// SECURITY: businessId is closure-bound from the trusted ctx at agent creation time.
// Both DB queries are scoped by businessId — a foreign saleId or productId returns
// nothing, never leaking another tenant's weight data.
//
// Backend routing: always via LogisticaBackend port (in-process — no inline Prisma).
//   backendOverride (toolCtx) → test injection, bypasses createLogisticaBackend().
//   Default → createLogisticaBackend() (AGENT_LOGISTICA_BACKEND env forwarded internally).

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool, type ToolResult } from "@/lib/adk/tools/_shared/create-tool";
import type { LogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.port";
import { createLogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.factory";

// ── Zod input schema (runtime validation via createTool) ──────────────────────

const packageProfileParams = z.object({
  saleId: z
    .string()
    .optional()
    .describe("Velora Sale ID. Cuando se provee, el peso se calcula desde los SaleItems de la venta."),
  productIds: z
    .array(z.string())
    .optional()
    .describe("Array de Velora Product IDs. Usar cuando no se tiene saleId."),
  weightGramsOverride: z
    .number()
    .optional()
    .describe(
      "Peso total explícito en gramos provisto por el dueño. " +
        "Cuando se setea, omite la consulta por producto y devuelve hasRealWeightData:true.",
    ),
});

// ── Genai schema (LLM calling convention — separate from Zod validation) ──────

const SELECCIONAR_COURIER_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    saleId: {
      type: Type.STRING,
      description:
        "Velora Sale ID. Cuando se provee, el peso se calcula desde los SaleItems de la venta.",
    },
    productIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Array de Velora Product IDs. Usar cuando no se tiene saleId.",
    },
    weightGramsOverride: {
      type: Type.NUMBER,
      description:
        "Peso total explícito en gramos provisto por el dueño. " +
        "Omite consulta por producto cuando se setea.",
    },
  },
};

export interface PackageProfile {
  weightGrams: number;
  hasRealWeightData: boolean;
  itemCount: number;
}

/** Tool-scoped context for backend injection (mirrors EmitInvoiceToolContext pattern). */
export interface GetPackageProfileToolCtx {
  /**
   * Optional LogisticaBackend injected for testing — bypasses both the
   * AGENT_LOGISTICA_BACKEND env flag and the legacy prisma query path.
   * Default: null → falls through to flag-based routing.
   */
  backendOverride?: LogisticaBackend | null;
}

/**
 * Factory — closure-binds the trusted businessId so the LLM cannot override it.
 * Registers the tool as "logistica.seleccionar_courier" via createTool factory.
 * Both DB reads are scoped by businessId: a foreign saleId or productId returns
 * zero rows, never exposing another tenant's weight data.
 *
 * Routing (evaluated at call time — reads env at execute() time, not module-load):
 *   1. toolCtx.backendOverride present → use it (test injection).
 *   2. Always delegates getPackageProfile through createLogisticaBackend()
 *      (in-process port call — no inline Prisma). Tenant-scoped by businessId.
 */
export function createGetPackageProfileTool(
  trustedBusinessId: string,
  toolCtx: GetPackageProfileToolCtx = {},
) {
  return createTool({
    name: "logistica.seleccionar_courier",
    description:
      "Calcula el perfil del paquete (peso, cantidad de ítems) para un envío. " +
      "Paso previo obligatorio antes de logistica.cotizar_envio cuando no se conoce el peso. " +
      "Acepta un saleId, una lista de productIds, o un weightGramsOverride explícito. " +
      "Usa Product.weightGrams cuando disponible; default: 500 g/unidad. " +
      "hasRealWeightData:true solo cuando todos los ítems tenían datos reales.",
    schema: SELECCIONAR_COURIER_SCHEMA,
    inputSchema: packageProfileParams,
    backend: { trustedBusinessId },
    execute: async ({ input }) => {
      const { saleId, productIds, weightGramsOverride } = input;
      // businessId comes from the trusted closure — never from LLM input.
      const businessId = trustedBusinessId;

      // ── Always via port — no inline Prisma ───────────────────────────────────
      // Priority: backendOverride (test injection) > createLogisticaBackend() default.
      // Tenant isolation (businessId scoping) is enforced inside the adapter.
      const backend: LogisticaBackend =
        toolCtx.backendOverride ?? createLogisticaBackend();

      const profileResult = await backend.getPackageProfile({
        tenantId: businessId,
        saleId,
        productIds,
        weightGramsOverride,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PackageProfileResult.breakdown array is not assignable to Record<string,unknown> without widening cast
      return profileResult as any as ToolResult;
    },
  });
}
