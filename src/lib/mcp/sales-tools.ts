// src/lib/mcp/sales-tools.ts — Stateful money-path MCP tool registrations (Batch 4 + remaining).
//
// Registers three tenant-scoped tools on a McpServer instance:
//   - register_sale           : creates a full sale (products + qty) with cascade
//                               (items + inventory.decrement + stock-movement +
//                               cash-movement + invoice). Idempotent.
//   - register_movement       : records a cash-register movement (income/expense).
//   - return_sale             : reverses the N most-recent sales (stock + cash reversal).
//                               MONEY/INVENTORY: reuses undoSaleBatchInTransaction.
//
// SECURITY: businessId ALWAYS from the closure — NEVER from tool input.
// Caller-supplied IDs (productId, customerId) are scoped by the
// closure businessId inside every use-case — foreign IDs → not-found / isError.
//
// All money mutations reuse canonical use-cases:
//   register_sale          → createSaleUseCase
//   register_movement      → createCashMovementUseCase
//
// Handlers extracted to ./_lib/sales-mutations.ts to keep this file under the
// 300-LOC project limit.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SalesBackend } from "./_lib/sales-backend.port";

// ── Input schemas (extracted to keep registerSalesTools under 150 LOC) ────────

const SALE_ITEM_SCHEMA = z.object({
  productId: z.string().min(1).describe("Product ID (must belong to this business)."),
  quantity: z.number().int().positive().describe("Units sold (positive integer)."),
  unitPrice: z.number().positive().optional().describe(
    "Sale price per unit in ARS. Optional — when omitted, the catalog price from the DB is used (recommended). " +
    "When supplied, it is validated against the catalog: deviations greater than 50% are rejected with PRICE_OUTLIER. " +
    "Supply only when the owner explicitly states a price override within the allowed band."
  ),
});

const REGISTER_SALE_SCHEMA = {
  items: z.array(SALE_ITEM_SCHEMA).min(1).max(500).describe("Line items for the sale. At least one required (max 500)."),
  customerId: z.string().optional().describe("Optional customer ID. Must belong to this business. Omit for anonymous sales."),
  paymentMethod: z.enum(["efectivo", "transferencia", "mp", "qr", "modo"]).optional()
    .describe("Payment method. Defaults to 'efectivo' when omitted."),
  requestId: z.string().optional()
    .describe("Optional opaque caller ID. When supplied it is folded into the server-side idempotency key, forcing a distinct sale even when the basket (items + customerId) is identical to a prior call. Use to record two legitimate same-basket sales without dedup collision. The key is always server-derived — this value never bypasses tenant isolation."),
};

const REGISTER_MOVEMENT_SCHEMA = {
  type: z.enum(["purchase", "tax", "salary", "adjustment", "income", "sale"])
    .describe("Movement type: 'purchase'=supplier payment, 'income'=ad-hoc income, 'salary'=payroll, 'tax'=tax, 'adjustment'=correction."),
  description: z.string().min(1).describe("Description (e.g. 'Pago proveedor Distribuidora ABC')."),
  amount: z.number().positive().describe("Amount in ARS (always positive). The 'type' controls the direction."),
  date: z.string().optional().describe("ISO 8601 date/datetime. Defaults to now when omitted."),
};

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers the three money-path tools on the given server.
 * Called only when a verified businessId is available from the auth gate.
 *
 * The injected SalesBackend covers the three write tools
 * (register_sale, register_movement, return_sale).
 */
export function registerSalesTools(server: McpServer, businessId: string, backend: SalesBackend): void {
  server.registerTool(
    "register_sale",
    {
      title: "Register sale",
      description:
        "Use this when the owner says they sold something and you need to record it immediately. " +
        "Records a sale for the authenticated business. Creates a full Sale with SaleItems, " +
        "decrements inventory, creates a CashMovement and Invoice — the same cascade as the " +
        "dashboard register-sale flow. " +
        "PRICES: unitPrice per item is optional. When omitted, the catalog price from the DB is used " +
        "(recommended — prevents LLM hallucination). When supplied, it is validated against the catalog " +
        "and rejected with PRICE_OUTLIER if it deviates by more than 50%. Always omit unitPrice unless " +
        "the owner explicitly stated a price override. " +
        "productId values MUST belong to this business — foreign IDs return PRODUCT_NOT_OWNED (isError). " +
        "customerId is optional; omit for anonymous sales. " +
        "Idempotent: the same (products, qty, customerId) combination deduplicates. " +
        "Supply requestId to force a distinct sale when the same basket must be recorded twice. " +
        "If the customer will pay via MercadoPago (online/Checkout Pro), use open_payment_link_wizard instead.",
      inputSchema: REGISTER_SALE_SCHEMA,
      // Standard MCP tool annotations — https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    (args) => backend.registerSale({ businessId, ...args }),
  );

  server.registerTool(
    "register_movement",
    {
      title: "Register cash movement",
      description:
        "Use this when you need to record a NON-sale cash/ledger entry (supplier payment, salary, tax, ad-hoc income) NOT tied to a caja shift. " +
        "If the business uses the caja (shift) system, use `caja_registrar_movimiento` instead. " +
        "Records a cash-register movement for the authenticated business. " +
        "Use 'purchase' for supplier payments, 'income' for ad-hoc income, 'salary' for payroll, " +
        "'tax' for taxes, 'adjustment' for corrections. " +
        "Do NOT use type 'sale' — reserved for CashMovements auto-created by register_sale. " +
        "Idempotent: the same (type, description, amount, date) deduplicates. " +
        "Returns movementId, type, amount, description, and date on success.",
      inputSchema: REGISTER_MOVEMENT_SCHEMA,
      // Standard MCP tool annotations — https://modelcontextprotocol.io/specification/2025-06-18/schema
      // destructiveHint: true — creates an irreversible CashMovement record (real money mutation).
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    (args) => {
      // Runtime guard: 'sale' is reserved for CashMovements auto-created by register_sale.
      // The enum keeps 'sale' so existing schema consumers don't break, but callers must
      // never supply it directly — doing so would create a ghost ledger entry outside the
      // canonical sale cascade (inventory + invoice + sale record).
      if (args.type === "sale") {
        return Promise.resolve({
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              code: "RESERVED_TYPE",
              message:
                "Type 'sale' is reserved for CashMovements created automatically by register_sale. " +
                "Use 'income' for ad-hoc income, 'purchase' for supplier payments, " +
                "'salary' for payroll, 'tax' for taxes, or 'adjustment' for corrections.",
            }),
          }],
          isError: true,
        });
      }
      return backend.registerMovement({ businessId, ...args });
    },
  );

  server.registerTool(
    "return_sale",
    {
      title: "Return sale",
      description:
        "Use this when the owner says a recent sale was a mistake and must be undone. " +
        "Do not use `register_movement` to undo a sale — this tool is the correct path. " +
        "Reverses the N most-recent sales within a time window for the authenticated business. " +
        "Restores inventory, removes CashMovement, SaleItem, Invoice, and Sale records. " +
        "Blocked when any targeted sale has an invoice already sent or paid (returns INVOICE_LOCKED). " +
        "MONEY/INVENTORY: this is a destructive, irreversible operation. " +
        "REQUIRED: you MUST pass confirm: true to execute the reversal — calling without it (or with confirm: false) returns a validation error and no sale is reversed. " +
        "Returns { returned, summary } on success. Idempotent: same (count, cutoffHours) within the " +
        "same hour deduplicates.",
      inputSchema: {
        confirm: z.literal(true)
          .describe("Must be explicitly true to confirm reversing sales — this is destructive."),
        count: z.number().int().positive().max(10).default(1)
          .describe("Number of recent sales to reverse (max 10, default 1)."),
        cutoffHours: z.number().positive().max(48).default(24)
          .describe("Only consider sales within the last N hours (max 48, default 24)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    (args) => backend.returnSale({ businessId, count: args.count, cutoffHours: args.cutoffHours }),
  );
}
