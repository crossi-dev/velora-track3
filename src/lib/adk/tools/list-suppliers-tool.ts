import "server-only";
// FunctionTool for list_suppliers.
//
// Returns the business's suppliers (name + phone + contactName), alphabetically.
// Designed for the Owner Assistant so "qué proveedores tengo" resolves
// without falling through to the Supervisor.
//
// Tenant isolation: businessId is captured in the factory closure — it is
// NEVER read from tool args. Mirrors the list-customers-tool / check-stock-tool
// factory pattern.
//
// Read-only: no mutations, no idempotency key, no CriticalWriteEvent.
//
// Port delegation: prisma.supplier.findMany is now in VeloraSupplierAdapter.listSuppliers.
// The tool calls createSupplierBackend() in-process (mirrors stock-consultar-tool pattern).

import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createSupplierBackend } from "@/lib/mcp/_lib/supplier-backend.factory";
import type { SupplierBackend } from "@/lib/mcp/_lib/supplier-backend.port";

export interface ListSuppliersToolContext {
  businessId: string;
  /** Optional backend override for testing (injected instead of factory). */
  backendOverride?: SupplierBackend;
}

const LIST_SUPPLIERS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    search: {
      type: Type.STRING,
      description:
        "Optional name fragment to filter suppliers. Leave empty to list all (up to 50).",
    },
  },
};

export function createListSuppliersTool(ctx: ListSuppliersToolContext) {
  return new FunctionTool({
    name: "list_suppliers",
    description:
      "List the business's suppliers (name + phone + contact). Use for questions like " +
      "'¿qué proveedores tengo?', '¿cuántos proveedores hay?', " +
      "'mostrame los proveedores'. Returns up to 50 suppliers, sorted by name. " +
      "Optionally filter by name fragment via the search parameter.",
    parameters: LIST_SUPPLIERS_SCHEMA,
    execute: async (args: unknown) => {
      const input = args as { search?: string };
      const search = typeof input?.search === "string" ? input.search.trim() : undefined;

      const backend = ctx.backendOverride ?? createSupplierBackend();
      const rows = await backend.listSuppliers({
        tenantId: ctx.businessId,
        search: search || undefined,
      });

      return {
        suppliers: rows,
        total: rows.length,
        capped: rows.length === 50,
      };
    },
  });
}
