// Logística tool — logistica.crear_etiqueta
// Routes the create request to the adapter chosen by the caller (based on the
// provider returned by logistica.cotizar_envio). No single courier is hardcoded here.
//
// Interface reshape (feat/logistica-tools): tool is now registered under the
// canonical "logistica.crear_etiqueta" namespace via createTool factory.
// Market shape source: EasyPost Shipments https://docs.easypost.com/docs/shipments
//   Fields: from_address/to_address → origin/customer fields, parcel → weightGrams,
//           carrier → provider, service → service.
//
// SECURITY: businessId is closure-bound from the trusted ctx at agent creation time.
// The LLM-supplied businessId field in the schema is retained for prompt legibility
// but is NEVER used in execute() — the closure value is always authoritative.
//
// Backend routing (AGENT_LOGISTICA_BACKEND, separate from LOGISTICA_BACKEND MCP flag):
//   Unset / blank → LEGACY: getCourierEntry() called directly from courier-registry.
//   Set            → route getCourierEntryForCreate through createLogisticaBackend().
//   backendOverride (toolCtx) → test injection, bypasses flag entirely.
// The prisma.andreaniShipment dedup check stays in this tool — tool-layer idempotency.
// Provider adapter.create() call stays in this tool — tool-layer logic.

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "@/lib/adk/tools/_shared/create-tool";
import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { getCourierEntry, getActiveCourierNames } from "../courier-registry";
import type { LogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.port";
import { createLogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.factory";

// Build the provider enum at module load time from the active courier registry.
// Encajonados (active:false) are excluded so the model cannot invoke them via tool schemas.
// STATIC CONSTRAINT: this enum is fixed at module initialization (cold start).
// Toggling courier_registry.active requires a Cloud Run cold start to take effect —
// a running instance will not pick up the change until it is restarted.
const [firstActive, ...restActive] = getActiveCourierNames() as [string, ...string[]];
const activeProviderEnum = z.enum([firstActive, ...restActive]);

const createShipmentParams = z.object({
  businessId: z.string().describe("Velora Business ID — resolución de credenciales por tenant."),
  provider: activeProviderEnum
    .describe(
      "Courier a usar para el envío. Pasar el valor 'provider' del resultado de logistica.cotizar_envio " +
      `confirmado por el dueño. Providers activos: ${[firstActive, ...restActive].join(", ")}.`,
    ),
  saleId: z.string().describe("Velora Sale ID al que se vincula el envío."),
  customerName: z.string().describe("Nombre del destinatario (to_address.name en EasyPost)."),
  customerLastName: z
    .string()
    .optional()
    .describe("Apellido del destinatario (opcional). Requerido por OCA."),
  customerAddress: z.string().describe("Calle del destinatario sin número (to_address.street1)."),
  customerAddressNumber: z
    .string()
    .optional()
    .describe(
      "Número de calle del destinatario (to_address.street2). Requerido por OCA para entrega a domicilio.",
    ),
  customerPostalCode: z
    .string()
    .describe("Código postal del destinatario (4-5 dígitos)."),
  customerCity: z
    .string()
    .optional()
    .describe("Ciudad/localidad del destinatario (to_address.city). Recomendado para ruteo Andreani."),
  customerProvince: z
    .string()
    .optional()
    .describe(
      "Provincia del destinatario (to_address.state). Requerido por OCA para entrega a domicilio.",
    ),
  customerPhone: z
    .string()
    .optional()
    .describe("Teléfono del destinatario (to_address.phone). Opcional."),
  customerDni: z
    .string()
    .optional()
    .describe(
      "DNI del destinatario (requerido por Andreani en producción). Si falta, Andreani rechaza la orden.",
    ),
  service: z
    .string()
    .optional()
    .describe(
      "Clave de servicio del courier (parcel.predefined_package en EasyPost). " +
        "Valores: 'domicilio', 'sucursal', 'express' para Andreani; service string de OCA/Correo. " +
        "Pasar el campo CourierOption.service del resultado de logistica.cotizar_envio. Default: 'domicilio'.",
    ),
  weightGrams: z
    .number()
    .describe("Peso total del envío en gramos (parcel.weight en EasyPost)."),
});

// ── Genai schema (LLM calling convention — separate from Zod validation) ──────

const CREAR_ETIQUETA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    businessId: { type: Type.STRING, description: "Velora Business ID — resolución de credenciales por tenant." },
    provider: { type: Type.STRING, description: `Courier confirmado por el dueño. Activos: ${[firstActive, ...restActive].join(", ")}.` },
    saleId: { type: Type.STRING, description: "Velora Sale ID al que se vincula el envío." },
    customerName: { type: Type.STRING, description: "Nombre del destinatario." },
    customerLastName: { type: Type.STRING, description: "Apellido del destinatario (opcional, requerido por OCA)." },
    customerAddress: { type: Type.STRING, description: "Calle del destinatario sin número." },
    customerAddressNumber: { type: Type.STRING, description: "Número de calle (requerido por OCA)." },
    customerPostalCode: { type: Type.STRING, description: "Código postal del destinatario (4-5 dígitos)." },
    customerCity: { type: Type.STRING, description: "Ciudad/localidad del destinatario." },
    customerProvince: { type: Type.STRING, description: "Provincia del destinatario (requerida por OCA)." },
    customerPhone: { type: Type.STRING, description: "Teléfono del destinatario (opcional)." },
    customerDni: { type: Type.STRING, description: "DNI del destinatario (requerido por Andreani en producción)." },
    service: { type: Type.STRING, description: "Servicio del courier: 'domicilio', 'sucursal', 'express'. Default: 'domicilio'." },
    weightGrams: { type: Type.NUMBER, description: "Peso total del envío en gramos." },
  },
  required: ["businessId", "provider", "saleId", "customerName", "customerAddress", "customerPostalCode", "weightGrams"],
};

/** Tool-scoped context for backend injection (mirrors EmitInvoiceToolContext pattern). */
export interface CreateShipmentToolCtx {
  /**
   * Optional LogisticaBackend injected for testing — bypasses both the
   * AGENT_LOGISTICA_BACKEND env flag and the legacy getCourierEntry path.
   * Default: null → falls through to flag-based routing.
   */
  backendOverride?: LogisticaBackend | null;
}

/**
 * Factory — closure-binds the trusted businessId so the LLM cannot override it.
 * Registers the tool as "logistica.crear_etiqueta" via createTool factory.
 *
 * Routing (evaluated at call time — reads env at execute() time, not module-load):
 *   1. toolCtx.backendOverride present → use it (test injection, bypasses flag).
 *   2. AGENT_LOGISTICA_BACKEND set (non-blank) → route getCourierEntryForCreate through
 *      createLogisticaBackend() for per-tenant routing and non-Velora backend support.
 *   3. Unset / blank → legacy getCourierEntry() (byte-for-byte unchanged).
 *
 * Flag is intentionally SEPARATE from LOGISTICA_BACKEND (MCP path).
 * Dedup check (prisma.andreaniShipment) and adapter.create() stay in this tool.
 */
export function createCreateShipmentTool(
  trustedBusinessId: string,
  toolCtx: CreateShipmentToolCtx = {},
) {
  return createTool({
    name: "logistica.crear_etiqueta",
    description:
      "Crea un envío físico con el courier elegido y devuelve número de tracking y URL de etiqueta. " +
      "Llamar DESPUÉS de que el dueño confirme la opción de logistica.cotizar_envio. " +
      "Pasar el provider y service del CourierOption elegido.",
    schema: CREAR_ETIQUETA_SCHEMA,
    inputSchema: createShipmentParams,
    backend: { trustedBusinessId, toolCtx },
    execute: async ({ input }) => {
      // businessId comes from the trusted closure — ignore whatever the LLM passed.
      const {
        provider,
        saleId,
        customerName,
        customerLastName,
        customerAddress,
        customerAddressNumber,
        customerPostalCode,
        customerCity,
        customerProvince,
        customerPhone,
        customerDni,
        service,
        weightGrams,
      } = input;
      const businessId = trustedBusinessId;

      // ── Backend routing (read env at call time — not module-load) ────────────
      // Priority: backendOverride (test injection) > AGENT_LOGISTICA_BACKEND env > null (legacy).
      const agentLogisticaBackend = (process.env.AGENT_LOGISTICA_BACKEND ?? "").trim();
      const backend: LogisticaBackend | null =
        toolCtx.backendOverride ??
        (agentLogisticaBackend ? createLogisticaBackend(agentLogisticaBackend) : null);

      const courierEntry = backend
        ? (await backend.getCourierEntryForCreate({ tenantId: businessId, provider })).courierEntry
        : getCourierEntry(provider);
      if (!courierEntry) {
        return {
          error: {
            code: "UNKNOWN_PROVIDER",
            message: `Provider desconocido: '${provider}'. Llamar logistica.cotizar_envio primero para obtener un valor válido.`,
          },
        };
      }

      // Code-level idempotency guard — prompt-level instructions alone are not reliable.
      // NOTE: this check queries andreaniShipment only — it is Andreani-specific.
      // OCA dedup lives in oca-adapter.ts (create() → prisma.ocaShipment.create + P2002 catch).
      // If a shipment already exists for this (businessId, saleId) pair in Andreani, return the
      // existing tracking number without calling the courier API a second time.
      // This prevents a duplicate orphan booking at the courier for retried LLM calls
      // or double-fire from the post-commit logistica trigger.
      const existingShipment = await prisma.andreaniShipment.findFirst({
        where: { saleId, businessId },
        select: { trackingNumber: true },
      });
      if (existingShipment) {
        cloudLog({
          severity: "INFO",
          component: "A2A",
          action: "LOGISTICA_CREATE_SHIPMENT_ALREADY_EXISTS",
          a2a_transfer: false,
          message: `logistica.crear_etiqueta dedup — shipment already exists for saleId=${saleId}`,
          data: { businessId, saleId, trackingNumber: existingShipment.trackingNumber },
        });
        return {
          success: true,
          alreadyExists: true,
          trackingNumber: existingShipment.trackingNumber,
          message: `Shipment ya existe para esta venta (${existingShipment.trackingNumber}). No se creó uno nuevo.`,
        };
      }

      cloudLog({
        severity: "INFO",
        component: "A2A",
        action: "LOGISTICA_CREATE_SHIPMENT",
        a2a_transfer: false,
        message: `logistica.crear_etiqueta → ${courierEntry.name}: saleId=${saleId}`,
        data: { businessId, saleId, provider: courierEntry.name, weightGrams },
      });

      const adapter = courierEntry.getAdapter();
      const rpcResponse = await adapter.create(
        {
          saleId,
          customer: {
            name:          customerName,
            lastName:      customerLastName ?? "",
            address:       customerAddress,
            addressNumber: customerAddressNumber ?? "",
            postalCode:    customerPostalCode,
            city:          customerCity ?? "",
            province:      customerProvince ?? "",
            phone:         customerPhone ?? "",
            dni:           customerDni ?? null,
          },
          service: service ?? "domicilio",
          weightGrams,
        },
        businessId,
      );

      if ("error" in rpcResponse) {
        const errMsg = rpcResponse.error.message;
        cloudLog({
          severity: "ERROR",
          component: "A2A",
          action: "LOGISTICA_CREATE_SHIPMENT_FAILED",
          a2a_transfer: false,
          message: errMsg,
          data: { businessId, saleId, provider: courierEntry.name },
        });
        return { error: { code: "COURIER_ERROR", message: errMsg } };
      }

      const textPart = rpcResponse.result?.parts?.[0]?.text ?? "";
      return { success: true, provider: courierEntry.name, text: textPart };
    },
  });
}
