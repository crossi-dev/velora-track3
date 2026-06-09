import "server-only";
// FunctionTool for list_customers.
//
// Returns the business's customers (name + phone), newest first, capped at 50.
// Designed for the Owner Assistant so "quiénes son mis clientes" resolves
// without falling through to the Supervisor.
//
// Tenant isolation: businessId is captured in the factory closure — it is
// NEVER read from tool args. Mirrors the check-stock-tool / business-query-tool
// factory pattern.
//
// Read-only: no mutations, no idempotency key, no CriticalWriteEvent.
//
// Port delegation: prisma.customer.findMany is now in VeloraCustomerAdapter.listCustomers.
// The tool calls createCustomerBackend() in-process (mirrors stock-consultar-tool pattern).

import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createCustomerBackend } from "@/lib/mcp/_lib/customer-backend.factory";
import type { CustomerBackend } from "@/lib/mcp/_lib/customer-backend.port";

export interface ListCustomersToolContext {
  businessId: string;
  /** Optional backend override for testing (injected instead of factory). */
  backendOverride?: CustomerBackend;
}

const LIST_CUSTOMERS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    search: {
      type: Type.STRING,
      description:
        "Optional name fragment to filter customers. Leave empty to list all (up to 50 newest).",
    },
  },
};

export function createListCustomersTool(ctx: ListCustomersToolContext) {
  return new FunctionTool({
    name: "list_customers",
    description:
      "List the business's customers (name + phone). Use for questions like " +
      "'¿quiénes son mis clientes?', '¿cuántos clientes tengo?', " +
      "'mostrame la lista de clientes'. Returns up to 50 customers, newest first. " +
      "Optionally filter by name fragment via the search parameter.",
    parameters: LIST_CUSTOMERS_SCHEMA,
    execute: async (args: unknown) => {
      const input = args as { search?: string };
      const search = typeof input?.search === "string" ? input.search.trim() : undefined;

      const backend = ctx.backendOverride ?? createCustomerBackend();
      const rows = await backend.listCustomers({
        tenantId: ctx.businessId,
        search: search || undefined,
      });

      return {
        customers: rows,
        total: rows.length,
        capped: rows.length === 50,
      };
    },
  });
}
