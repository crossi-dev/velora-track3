import "server-only";
// stock-transferir-tool.ts — stock.transferir_entre_sucursales FunctionTool via createTool.
//
// Source: Lightspeed createConsignment (outlet transfer shape):
//   https://x-series-api.lightspeedhq.com/reference/createconsignment
//
// MULTI-LOCATION PREREQUISITE:
//   Velora is currently single-location. The Product model has no branchId.
//   This tool is fully callable so the ADK agent has a defined surface, but
//   it returns MULTI_LOCATION_REQUIRED until the following additive migration
//   is applied:
//     - Add `Branch` model (id, businessId, name)
//     - Add `Product.branchId` (FK → Branch, nullable for backward compat)
//     - Add `StockMovement.fromBranchId` + `toBranchId` (nullable)
//   When migration is applied: remove the guard below and wire real DB logic.

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "./_shared/create-tool";
import type { StockToolsBackend } from "./stock-tools-backend";

const TransferirEntreSucursalesInput = z.object({
  product_name: z.string().min(1, "El nombre del producto es requerido."),
  quantity: z
    .number()
    .int("La cantidad debe ser un número entero.")
    .positive("La cantidad debe ser mayor a 0."),
  from_branch: z.string().min(1, "El nombre de la sucursal de origen es requerido."),
  to_branch: z.string().min(1, "El nombre de la sucursal de destino es requerido."),
  idempotency_key: z
    .string()
    .min(1, "La clave de idempotencia es requerida.")
    .describe("Formato: transfer-{producto}-{origen}-{destino}-{timestamp}."),
});

const TRANSFERIR_ENTRE_SUCURSALES_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    product_name: {
      type: Type.STRING,
      description: "Nombre del producto a transferir entre sucursales.",
    },
    quantity: {
      type: Type.NUMBER,
      description: "Cantidad de unidades a transferir. Mayor a 0.",
    },
    from_branch: {
      type: Type.STRING,
      description: "Nombre de la sucursal de origen.",
    },
    to_branch: {
      type: Type.STRING,
      description: "Nombre de la sucursal de destino.",
    },
    idempotency_key: {
      type: Type.STRING,
      description:
        "Clave única de idempotencia. Formato: transfer-{producto}-{origen}-{destino}-{timestamp}.",
    },
  },
  required: ["product_name", "quantity", "from_branch", "to_branch", "idempotency_key"],
};

export function createTransferirEntreSucursalesTool(backend: StockToolsBackend) {
  return createTool({
    name: "stock.transferir_entre_sucursales",
    description:
      "Transfiere unidades de un producto entre sucursales. " +
      "NOTA: Velora opera con una sola ubicación actualmente. " +
      "Esta operación requiere el módulo de multi-sucursales.",
    schema: TRANSFERIR_ENTRE_SUCURSALES_SCHEMA,
    inputSchema: TransferirEntreSucursalesInput,
    backend,
    execute: async ({ input }) => {
      // PREREQUISITE GUARD — remove when multi-location migration is applied.
      return {
        error: {
          code: "MULTI_LOCATION_REQUIRED",
          message:
            `La transferencia entre sucursales requiere el módulo de multi-sucursales habilitado. ` +
            `Velora actualmente opera con una sola ubicación. ` +
            `Solicitud: ${input.quantity} "${input.product_name}" de "${input.from_branch}" → "${input.to_branch}".`,
        },
      };
    },
  });
}
