// src/lib/mcp/logistica-tools.ts — Logística MCP tool registrations.
// Tools: quote_shipping, create_shipment, track_shipment, get_package_profile.
// Helpers in ./_lib/logistica-helpers.ts; weight computation in ./_lib/logistica-package-profile.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LogisticaBackend } from "./_lib/logistica-backend.port";
import { createLogisticaBackend } from "./_lib/logistica-backend.factory";
import { extractResultText, parseOptions, registerPackageProfileTool, checkOcaRequiredFields, errResponse } from "./_lib/logistica-helpers";
import { COURIER_REGISTRY } from "@/app/api/agents/logistica/jsonrpc/_lib/courier-registry";

/**
 * Registers the four logistica tools on the given server.
 * Called only when a verified businessId is available from the auth gate.
 * Optional `backend` defaults to VeloraLogisticaAdapter (LOGISTICA_BACKEND env, default "velora").
 */
export function registerLogisticaTools(
  server: McpServer,
  businessId: string,
  backend: LogisticaBackend = createLogisticaBackend(),
): void {
  // ── Tool: quote_shipping ───────────────────────────────────────────────────
  server.registerTool(
    "quote_shipping",
    {
      title: "Quote shipping",
      description:
        "Quotes shipment rates from every active courier configured for the authenticated " +
        "business and returns options sorted by price ascending. Call this before choosing a " +
        "courier — never pick one without showing the comparison. " +
        "Returns an empty options array when no couriers are connected (not an error). " +
        "Each option includes provider, service, serviceLabel, priceARS, and estimatedDays.",
      inputSchema: {
        originPostalCode: z
          .string()
          .describe("Origin postal code (4 digits, no letters). Required."),
        destinationPostalCode: z
          .string()
          .describe("Destination postal code (4 digits, no letters). Required."),
        weightGrams: z
          .number()
          .positive()
          .describe("Total shipment weight in grams. Required."),
        declaredValue: z
          .number()
          .nonnegative()
          .optional()
          .describe("Declared value in ARS for insurance. Defaults to 0 when omitted."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const { activeCouriers } = await backend.resolveActiveCouriers({
        tenantId: businessId,
        originPostalCode: args.originPostalCode,
        destinationPostalCode: args.destinationPostalCode,
        weightGrams: args.weightGrams,
        declaredValue: args.declaredValue,
      });

      if (activeCouriers.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                options: [],
                cheapestPriceARS: null,
                originPostalCode: args.originPostalCode,
                destinationPostalCode: args.destinationPostalCode,
                weightGrams: args.weightGrams,
                message:
                  "No hay couriers activos para este negocio. El dueño debe conectar un courier en Configuración.",
              }),
            },
          ],
        };
      }

      const settled = await Promise.allSettled(
        activeCouriers.map(async (courier) => {
          const adapter = courier.getAdapter();
          const rpcResponse = await adapter.quote(
            {
              originPostalCode: args.originPostalCode,
              destinationPostalCode: args.destinationPostalCode,
              weightGrams: args.weightGrams,
              declaredValue: args.declaredValue ?? 0,
            },
            businessId,
          );
          const text = extractResultText(rpcResponse) ?? "";
          return { courier: courier.name, text };
        }),
      );

      const allOptions: ReturnType<typeof parseOptions> = [];
      const partialFailures: Array<{ courier: string; reason: string }> = [];
      for (const [i, r] of settled.entries()) {
        if (r.status === "fulfilled") {
          allOptions.push(...parseOptions(r.value.text, r.value.courier));
        } else {
          // Collect failures so the agent knows a cheaper option may have been skipped.
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          partialFailures.push({ courier: activeCouriers[i]?.name ?? "unknown", reason });
        }
      }

      allOptions.sort((a, b) => a.priceARS - b.priceARS);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              options: allOptions,
              cheapestPriceARS: allOptions.length > 0 ? allOptions[0].priceARS : null,
              originPostalCode: args.originPostalCode,
              destinationPostalCode: args.destinationPostalCode,
              weightGrams: args.weightGrams,
              ...(partialFailures.length > 0 ? { partialFailures } : {}),
            }),
          },
        ],
      };
    },
  );

  // ── Tool: create_shipment ──────────────────────────────────────────────────
  server.registerTool(
    "create_shipment",
    {
      title: "Create shipment",
      description:
        "Creates a physical shipment via the chosen courier and returns a tracking number " +
        "and label URL. Call this AFTER obtaining a quote with quote_shipping and confirming " +
        "the courier choice. Pass the provider slug from the chosen option. " +
        "Returns isError: true when the courier is unknown, unavailable, or credentials are absent.",
      inputSchema: {
        provider: z
          .string()
          .describe(
            "Courier slug from the quote_shipping result. " +
              "Valid values: 'andreani', 'oca'. Pass exactly the provider field from the chosen option.",
          ),
        saleId: z
          .string()
          .describe(
            "Velora Sale ID — REQUIRED. Both couriers reject creation without it; " +
              "also the dedup key preventing duplicate labels on retry. Pass the real saleId.",
          ),
        customerName: z
          .string()
          .describe(
            "Recipient first name (or full name when last name is not available separately).",
          ),
        customerLastName: z.string().optional().describe("Recipient last name (optional)."),
        customerAddress: z
          .string()
          .describe("Recipient street name (without house number)."),
        customerAddressNumber: z
          .string()
          .optional()
          .describe(
            "Recipient street number. Required by OCA — omitting it causes a rejection.",
          ),
        customerPostalCode: z.string().describe("Recipient postal code (4 digits)."),
        customerCity: z
          .string()
          .optional()
          .describe("Recipient city or locality (recommended for Andreani routing)."),
        customerProvince: z
          .string()
          .optional()
          .describe(
            "Recipient province (e.g. 'Buenos Aires'). Required by OCA — omitting causes rejection.",
          ),
        customerPhone: z.string().optional().describe("Recipient phone number (optional)."),
        customerDni: z
          .string()
          .optional()
          .describe(
            "Recipient DNI. Required by Andreani in production — omitting it causes rejection.",
          ),
        service: z
          .string()
          .optional()
          .describe(
            "Courier-specific service key from quote_shipping result " +
              "(e.g. 'domicilio', 'sucursal', 'express'). Defaults to 'domicilio'.",
          ),
        weightGrams: z.number().positive().describe("Total shipment weight in grams."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true }, // irreversible: creates real courier label
    },
    async (args) => {
      const { courierEntry } = await backend.getCourierEntryForCreate({
        tenantId: businessId,
        provider: args.provider,
      });
      if (!courierEntry) {
        return errResponse(
          `Courier desconocido: '${args.provider}'. Usá quote_shipping para obtener un provider válido.`,
        );
      }
      // Mirror ADK guard (handle-logistica-rpc.ts ~L231-233): inactive couriers must not bypass encajonamiento.
      if (!courierEntry.active) {
        return errResponse(`Courier '${args.provider}' is not enabled for this business`);
      }

      // OCA requires addressNumber and province — reject early with a clear message rather than
      // letting the adapter call fail with an opaque upstream error.
      if (args.provider === "oca") {
        const ocaErr = checkOcaRequiredFields(args.customerAddressNumber, args.customerProvince);
        if (ocaErr) return errResponse(ocaErr);
      }

      const adapter = courierEntry.getAdapter();
      const rpcResponse = await adapter.create(
        {
          saleId: args.saleId,
          customer: {
            name: args.customerName,
            lastName: args.customerLastName ?? "",
            address: args.customerAddress,
            addressNumber: args.customerAddressNumber ?? "",
            postalCode: args.customerPostalCode,
            city: args.customerCity ?? "",
            province: args.customerProvince ?? "",
            phone: args.customerPhone ?? "",
            dni: args.customerDni ?? null,
          },
          service: args.service ?? "domicilio",
          weightGrams: args.weightGrams,
        },
        businessId,
      );

      const text = extractResultText(rpcResponse);
      if (text === null) {
        const errorBody = (rpcResponse as { error?: { message?: string } }).error;
        return errResponse(errorBody?.message ?? "Error interno del courier");
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── Tool: track_shipment ───────────────────────────────────────────────────
  server.registerTool(
    "track_shipment",
    {
      title: "Track shipment",
      description:
        "Tracks the current status and event history of a shipment by tracking number. " +
        "Pass the provider slug used when the shipment was created. " +
        "Accepts historical providers (e.g. a courier that was later disabled) so " +
        "previously created shipments can still be tracked. " +
        "Returns isError: true when the provider slug is unknown or the tracking API fails.",
      inputSchema: {
        trackingNumber: z
          .string()
          .describe("Tracking number returned by the courier at shipment creation time."),
        provider: z
          .string()
          .describe(
            "Courier that created the shipment. Pass the provider slug from create_shipment " +
              "or quote_shipping. Examples: 'andreani', 'oca'.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const { courierEntry } = await backend.getCourierEntryForTrack({
        tenantId: businessId,
        provider: args.provider,
      });
      if (!courierEntry) {
        const validNames = COURIER_REGISTRY.map((c) => `'${c.name}'`).join(", ");
        return errResponse(
          `Courier desconocido: '${args.provider}'. Valores válidos: ${validNames}.`,
        );
      }

      const adapter = courierEntry.getAdapter();
      const rpcResponse = await adapter.track({ trackingNumber: args.trackingNumber }, businessId);

      const text = extractResultText(rpcResponse);
      if (text === null) {
        const errorBody = (rpcResponse as { error?: { message?: string } }).error;
        return errResponse(errorBody?.message ?? "Error interno del courier");
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── Tool: get_package_profile — registration in logistica-helpers.ts ─────────
  registerPackageProfileTool(server, errResponse, businessId, backend);
}
