// src/lib/mcp/supplier-tools.ts — Stateful supplier + procurement WRITE tools (Batch 3 + remaining).
//
// Registers four tenant-scoped mutation tools on a McpServer instance:
//   - create_supplier         : creates a supplier (upsert-by-name semantics, mirrors Ventas).
//   - create_purchase_request : creates a procurement order to a supplier.
//   - edit_supplier           : updates name, phone, email, contactName, or leadTimeDays.
//   - delete_supplier         : removes a supplier (with audit trail).
//
// SECURITY: businessId ALWAYS from the closure — NEVER from tool input.
// supplierId from tool input is validated through the canonical repository which
// qualifies every query with businessId — foreign IDs surface as SUPPLIER_NOT_FOUND.
//
// Idempotency: every mutation goes through beginIdempotentMutation via the use-case ports.
//
// Tool handlers route through SupplierBackend — the Velora adapter wraps the existing
// use-case instances. A future backend (e.g. Fudo) implements the same port and
// requires ZERO changes here or in server.ts.
//
// References:
//   create-supplier.use-case         — src/application/use-cases/create-supplier.use-case.ts
//   create-purchase-request.use-case — src/application/use-cases/create-purchase-request.use-case.ts
//   prisma-supplier.repository       — src/infrastructure/persistence/prisma-supplier.repository.ts
//   prisma-purchase-request.repository — src/infrastructure/persistence/prisma-purchase-request.repository.ts
//   SERVER_MUTATION_CONTRACT         — src/app/api/_lib/mutation-contract-entries.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SupplierBackend } from "./_lib/supplier-backend.port";
import { createSupplierBackend } from "./_lib/supplier-backend.factory";
import { errResponse } from "./_lib/mcp-responses";

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers create_supplier, create_purchase_request, edit_supplier, and delete_supplier
 * on the given server.
 * Called only when a verified businessId is available from the auth gate.
 *
 * @param backend Optional SupplierBackend override for testing or future backend variants.
 *   Defaults to createSupplierBackend() which reads SUPPLIER_BACKEND env var (default "velora").
 *   Callers at src/lib/mcp/server.ts pass no backend — behavior is byte-for-byte identical
 *   to before this seam was introduced.
 */
export function registerSupplierTools(
  server: McpServer,
  businessId: string,
  backend: SupplierBackend = createSupplierBackend(),
): void {
  // ── Tool: list_suppliers ───────────────────────────────────────────────────
  server.registerTool(
    "list_suppliers",
    {
      title: "List suppliers",
      description:
        "Use this when you need to look up a supplier or resolve a supplierId before a purchase request, stock load, or supplier edit/delete. " +
        "Returns all suppliers for this business (up to 50, sorted by name). " +
        "Optionally filters by name substring (case-insensitive). " +
        "Each entry includes id, name, phone, and contactName. " +
        "Returns an empty array when no suppliers exist (not an error). " +
        "Returns isError: true only on infrastructure failures.",
      inputSchema: {
        search: z.string().optional().describe("Optional name substring to filter suppliers (case-insensitive)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const suppliers = await backend.listSuppliers({ tenantId: businessId, search: args.search });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ suppliers, total: suppliers.length }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return errResponse("LIST_SUPPLIERS_ERROR", message);
      }
    },
  );

  // ── Tool: create_supplier ──────────────────────────────────────────────────
  server.registerTool(
    "create_supplier",
    {
      title: "Create supplier",
      description:
        "Use this when the owner wants to add a new supplier. For customers use `upsert_customer`. " +
        "Creates a supplier for this business. " +
        "Within the idempotency window, a repeat call with the same name replays the original result. " +
        "After the TTL expires (or with a different idempotency key), a duplicate name returns " +
        "SUPPLIER_ALREADY_EXISTS (isError). " +
        "Returns the created supplier with id, name, phone, email, contactName, leadTimeDays.",
      inputSchema: {
        name: z.string().min(1).describe("Supplier name (must be unique within this business)."),
        phone: z.string().optional().describe("Supplier phone number (optional)."),
        email: z.string().email().optional().describe("Supplier email address (optional)."),
        contactName: z.string().optional().describe("Contact person name (optional)."),
        leadTimeDays: z.number().int().positive().optional().describe("Default lead time in days (optional, default 3)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      // destructiveHint: false — additive create of a NEW supplier; existing data untouched, reversible via delete_supplier.
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = await backend.createSupplier({
          tenantId: businessId,
          name: args.name,
          phone: args.phone ?? null,
          email: args.email ?? null,
          contactName: args.contactName ?? null,
          leadTimeDays: args.leadTimeDays ?? null,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message === "SUPPLIER_ALREADY_EXISTS") {
          return errResponse("SUPPLIER_ALREADY_EXISTS", "A supplier with this name already exists in this business.");
        }
        return errResponse("CREATE_SUPPLIER_ERROR", message);
      }
    },
  );

  // ── Tool: create_purchase_request ─────────────────────────────────────────
  server.registerTool(
    "create_purchase_request",
    {
      title: "Create purchase request",
      description:
        "Use this when the owner wants a procurement order to a supplier WITHOUT receiving stock now. " +
        "If also recording inbound stock, use `stock_load` with createPurchaseRequest:true instead of calling both. " +
        "Creates a procurement order (purchase request) to a supplier. " +
        "Either supplierId or supplierName must be provided. " +
        "supplierId MUST belong to this business — foreign IDs return not-found (isError). " +
        "Returns the created request with id, requestNumber, supplierId, supplierName, " +
        "itemName, quantity, unitPrice, and totalAmount.",
      inputSchema: {
        supplierId: z.string().optional().describe("Existing supplier ID (must belong to this business, optional if supplierName is provided)."),
        supplierName: z.string().optional().describe("Supplier name — used to resolve or create the supplier (optional if supplierId is provided)."),
        itemName: z.string().min(1).describe("Name of the item being ordered."),
        quantity: z.number().int().positive().describe("Quantity to order."),
        unitPrice: z.number().min(0).describe("Unit price per item in ARS."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      // destructiveHint: true — creates an irreversible procurement order record.
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        if (!args.supplierId && !args.supplierName) {
          return errResponse("VALIDATION_ERROR", "Either supplierId or supplierName must be provided.");
        }

        // Tenant isolation for caller-supplied supplierId:
        // The repository's createInTransaction uses throwOnSupplierIdMiss=true + businessId scoping.
        // A foreign supplierId throws SUPPLIER_NOT_FOUND — enforced by the adapter.
        const out = await backend.createPurchaseRequest({
          tenantId: businessId,
          supplierId: args.supplierId ?? null,
          supplierName: args.supplierName ?? null,
          itemName: args.itemName,
          quantity: args.quantity,
          unitPrice: args.unitPrice,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message === "SUPPLIER_NOT_FOUND") return errResponse("SUPPLIER_NOT_FOUND", "Supplier not found in this business.");
        if (message === "SUPPLIER_REQUIRED") return errResponse("VALIDATION_ERROR", "A valid supplier is required.");
        if (message === "BUSINESS_NOT_FOUND") return errResponse("BUSINESS_NOT_FOUND", "Business not found.");
        if (message === "PURCHASE_REQUEST_ITEM_REQUIRED") return errResponse("VALIDATION_ERROR", "itemName is required.");
        if (message === "PURCHASE_REQUEST_QUANTITY_INVALID") return errResponse("VALIDATION_ERROR", "quantity must be a positive integer.");
        if (message === "PURCHASE_REQUEST_UNIT_PRICE_INVALID") return errResponse("VALIDATION_ERROR", "unitPrice must be a valid non-negative number.");
        return errResponse("CREATE_PURCHASE_REQUEST_ERROR", message);
      }
    },
  );

  // ── Tool: edit_supplier ────────────────────────────────────────────────────
  server.registerTool(
    "edit_supplier",
    {
      title: "Edit supplier",
      description:
        "Updates an existing supplier. At least one field must change. " +
        "supplierId must belong to this business — foreign IDs return SUPPLIER_NOT_FOUND (isError). " +
        "Pass null for phone/email/contactName to explicitly clear the field. " +
        "Returns { supplierId, ok } on success. Idempotent: same args deduplicate.",
      inputSchema: {
        supplierId: z.string().min(1).describe("ID of the supplier to update (must belong to this business)."),
        name: z.string().min(1).optional().describe("New supplier name (optional)."),
        phone: z.string().nullable().optional().describe("New phone number, or null to clear (optional)."),
        email: z.string().email().nullable().optional().describe("New email address, or null to clear (optional)."),
        contactName: z.string().nullable().optional().describe("New contact person name, or null to clear (optional)."),
        leadTimeDays: z.number().int().positive().nullable().optional().describe("New default lead time in days, or null to clear (optional)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      // destructiveHint: true — overwrites existing supplier fields; overwrite is irreversible without a second call.
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = await backend.editSupplier({ tenantId: businessId, ...args });
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message === "SUPPLIER_NOT_FOUND") return errResponse("SUPPLIER_NOT_FOUND", "Supplier not found in this business.");
        return errResponse("EDIT_SUPPLIER_ERROR", message);
      }
    },
  );

  // ── Tool: delete_supplier ─────────────────────────────────────────────────
  server.registerTool(
    "delete_supplier",
    {
      title: "Delete supplier",
      description:
        "Use this only when the owner explicitly asks to remove a supplier. To update supplier details, use `edit_supplier` instead. " +
        "Deletes a supplier from this business (with full audit trail). " +
        "supplierId must belong to this business — foreign IDs return SUPPLIER_NOT_FOUND (isError). " +
        "Returns { supplierId, ok } on success. Idempotent: repeat calls deduplicate.",
      inputSchema: {
        supplierId: z.string().min(1).describe("ID of the supplier to delete (must belong to this business)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = await backend.deleteSupplier({ tenantId: businessId, supplierId: args.supplierId });
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message === "SUPPLIER_NOT_FOUND") return errResponse("SUPPLIER_NOT_FOUND", "Supplier not found in this business.");
        return errResponse("DELETE_SUPPLIER_ERROR", message);
      }
    },
  );
}
