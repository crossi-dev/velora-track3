// src/lib/mcp/customer-tools.ts — Stateful customer MCP tool registrations.
//
// Registers three tenant-scoped customer tools on a McpServer instance:
//   - find_customer    : search customers by name and/or phone (READ).
//   - upsert_customer  : create or update a customer matched by id or phone (LIGHT WRITE).
//   - delete_customer  : delete a customer (guarded: blocked when history records exist).
//
// These tools require a resolved businessId (from the auth gate) and are only
// registered when one is provided.
//
// Tenant isolation: businessId ALWAYS comes from the closure — never from tool input.
// The helper functions in ./_lib/customer-queries.ts scope every DB call by businessId.
//
// upsert_customer is NOT a money-path operation — no idempotency begin/complete is used.
// The underlying createCustomerInTransaction performs a phone-based upsert at the
// application layer (before the INSERT) so duplicate phone entries are safe.
//
// Error surface: failures return isError: true with { code, message } — tools do
// NOT throw on infra failure so LLM callers can detect and report them cleanly.
//
// References:
//   findCustomers / upsertCustomer — ./_lib/customer-queries.ts
//   createCustomerInTransaction    — src/infrastructure/shared/customer-mutations.ts
//   updateCustomerInTransaction    — src/infrastructure/shared/customer-mutations.ts
//   CustomerBackend port           — ./_lib/customer-backend.port.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CustomerBackend } from "./_lib/customer-backend.port";
import { createCustomerBackend } from "./_lib/customer-backend.factory";
import { errResponse } from "./_lib/mcp-responses";

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers find_customer and upsert_customer on the given server.
 * Called only when a verified businessId is available from the auth gate.
 *
 * @param backend Optional CustomerBackend override for testing or future backend variants.
 *   Defaults to createCustomerBackend() which reads CUSTOMER_BACKEND env var (default "velora").
 *   Callers at src/lib/mcp/server.ts pass no backend — behavior is byte-for-byte identical
 *   to before this seam was introduced.
 */
export function registerCustomerTools(
  server: McpServer,
  businessId: string,
  backend: CustomerBackend = createCustomerBackend(),
): void {
  // ── Tool: find_customer ────────────────────────────────────────────────────
  server.registerTool(
    "find_customer",
    {
      title: "Find customer",
      description:
        "Use this when you need to look up a customer by name or phone before chaining into a sale, payment, or message. " +
        "Searches customers in the business by name and/or phone. " +
        "Returns up to 20 matching customers sorted by name, each with " +
        "id, name, phone, email, address, postalCode, and city. " +
        "At least one of name or phone must be provided. " +
        "Name matching is case-insensitive substring. Phone matching is a " +
        "partial contains on the normalised number. " +
        "Returns an empty array when no customers match (not an error). " +
        "Returns isError: true only on infrastructure failures.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Customer name substring to search (case-insensitive). Optional when phone is provided."),
        phone: z
          .string()
          .optional()
          .describe("Customer phone number or partial number to search. Optional when name is provided."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      if (!args.name && !args.phone) {
        return errResponse(
          "MISSING_SEARCH_PARAMS",
          "At least one of name or phone must be provided to search customers.",
        );
      }
      try {
        const customers = await backend.findCustomer({
          tenantId: businessId,
          name: args.name,
          phone: args.phone,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ customers, total: customers.length }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return errResponse("CUSTOMER_QUERY_ERROR", message);
      }
    },
  );

  // ── Tool: upsert_customer ──────────────────────────────────────────────────
  server.registerTool(
    "upsert_customer",
    {
      title: "Upsert customer",
      description:
        "Use this when you need to add a new customer or update an existing one's contact details. " +
        "Creates a new customer or updates an existing one for the authenticated business. " +
        "UPDATE path: provide customerId to update a specific customer by id. " +
        "CREATE path: omit customerId. When phone is provided and a customer with that " +
        "phone already exists, the existing customer is returned (upsert-by-phone). " +
        "When name is omitted on create, it falls back to phone → email → 'Cliente'. " +
        "Returns the resulting customer record (id, name, phone, email, address, etc.). " +
        "Returns isError: true when the customerId is not found (CUSTOMER_NOT_FOUND), " +
        "when a conflicting duplicate is detected (CUSTOMER_ALREADY_EXISTS), or on " +
        "infrastructure failure (CUSTOMER_UPSERT_ERROR). " +
        "This tool is NOT a payment operation — no financial idempotency is applied.",
      inputSchema: {
        customerId: z
          .string()
          .optional()
          .describe("When provided, updates the customer with this id. Omit to create a new customer."),
        name: z
          .string()
          .optional()
          .describe("Customer display name. Required when creating without a phone or email."),
        phone: z
          .string()
          .optional()
          .describe(
            "Customer phone number. When creating: if a customer with this phone already exists, " +
            "that customer is returned instead of creating a duplicate.",
          ),
        email: z
          .string()
          .optional()
          .describe("Customer email address (optional)."),
        address: z
          .string()
          .optional()
          .describe("Customer street address (optional)."),
        postalCode: z
          .string()
          .optional()
          .describe("Customer postal code (optional)."),
        city: z
          .string()
          .optional()
          .describe("Customer city or locality (optional)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      // destructiveHint: true — the update path (matched by id/phone) overwrites existing customer fields irreversibly.
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const customer = await backend.upsertCustomer({
          tenantId: businessId,
          customerId: args.customerId,
          name: args.name,
          phone: args.phone,
          email: args.email,
          address: args.address,
          postalCode: args.postalCode,
          city: args.city,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ customer }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        // Surface domain errors distinctly so LLM callers can detect and handle them
        // without parsing a success-looking JSON — mirrors delete_customer pattern.
        if (message === "CUSTOMER_NOT_FOUND") return errResponse("CUSTOMER_NOT_FOUND", "Customer not found in this business.");
        if (message === "CUSTOMER_ALREADY_EXISTS") return errResponse("CUSTOMER_ALREADY_EXISTS", "A customer with this phone or email already exists.");
        return errResponse("CUSTOMER_UPSERT_ERROR", message);
      }
    },
  );

  // ── Tool: delete_customer ──────────────────────────────────────────────────
  server.registerTool(
    "delete_customer",
    {
      title: "Delete customer",
      description:
        "Use this only when the owner explicitly asks to permanently remove a customer. " +
        "Blocked when the customer has sales or invoices (returns HAS_HISTORY). To update or clear contact details, use `upsert_customer` instead. " +
        "Deletes a customer from this business (with full audit trail). " +
        "customerId must belong to this business — foreign IDs return CUSTOMER_NOT_FOUND (isError). " +
        "Returns { outcome: 'deleted', ok: true } on success. " +
        "Returns { outcome: 'has_history', invoiceCount, saleCount } when deletion is blocked. " +
        "Idempotent: repeat calls deduplicate.",
      inputSchema: {
        customerId: z.string().min(1).describe("ID of the customer to delete (must belong to this business)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = await backend.deleteCustomer({ tenantId: businessId, customerId: args.customerId });
        if (out.outcome === "has_history") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ code: "HAS_HISTORY", ...out }) }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message === "CUSTOMER_NOT_FOUND") return errResponse("CUSTOMER_NOT_FOUND", "Customer not found in this business.");
        return errResponse("DELETE_CUSTOMER_ERROR", message);
      }
    },
  );
}
