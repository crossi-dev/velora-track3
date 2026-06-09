// src/lib/mcp/sales-tools.ts — Stateful money-path MCP tool registrations (Batch 4 + remaining).
//
// Registers six tenant-scoped tools on a McpServer instance:
//   - register_sale           : creates a full sale (products + qty) with cascade
//                               (items + inventory.decrement + stock-movement +
//                               cash-movement + invoice). Idempotent.
//   - register_movement       : records a cash-register movement (income/expense).
//   - register_promesa_sale   : creates Sale + Invoice + PaymentIntent as a
//                               deferred payment (promesa / accounts-receivable).
//   - confirm_promesa_payment : marks an existing pending PaymentIntent as a
//                               promesa (deferred payment accepted).
//   - settle_promesa_payment  : records that the deferred cash arrived for a
//                               prior promesa (creates real CashMovement).
//   - return_sale             : reverses the N most-recent sales (stock + cash reversal).
//                               MONEY/INVENTORY: reuses undoSaleBatchInTransaction.
//
// SECURITY: businessId ALWAYS from the closure — NEVER from tool input.
// Caller-supplied IDs (productId, customerId, paymentIntentId) are scoped by the
// closure businessId inside every use-case — foreign IDs → not-found / isError.
//
// All money mutations reuse canonical use-cases:
//   register_sale          → createSaleUseCase
//   register_movement      → createCashMovementUseCase
//   register_promesa_sale  → registerPromesaSaleUseCase
//   confirm_promesa_payment→ confirmPromesaPaymentUseCase
//   settle_promesa_payment → settlePromesaUseCase
//
// Handlers extracted to ./_lib/sales-mutations.ts and ./_lib/promesa-mutations.ts
// to keep each file under the 300-LOC project limit.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SalesBackend } from "./_lib/sales-backend.port";
import {
  handleRegisterPromesaSale,
  handleConfirmPromesa,
  handleSettlePromesa,
} from "./_lib/promesa-mutations";

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

const PROMESA_ITEM_SCHEMA = z.object({
  productId: z.string().min(1).describe("Product ID (must belong to this business)."),
  quantity: z.number().int().positive().describe("Units (positive integer)."),
  unitPriceOverride: z.number().positive().optional()
    .describe("Override the DB price (optional). When omitted, the DB price is used."),
});

const REGISTER_SALE_SCHEMA = {
  items: z.array(SALE_ITEM_SCHEMA).min(1).max(500).describe("Line items for the sale. At least one required (max 500)."),
  customerId: z.string().optional().describe("Optional customer ID. Must belong to this business. Omit for anonymous sales."),
  paymentMethod: z.enum(["efectivo", "transferencia", "mp", "qr", "promesa", "modo"]).optional()
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

const REGISTER_PROMESA_SCHEMA = {
  customerId: z.string().min(1).describe("Customer ID for the promesa. Must belong to this business."),
  items: z.array(PROMESA_ITEM_SCHEMA).min(1).describe("Line items. At least one required."),
  expectedAt: z.string().describe("Date when payment is expected (YYYY-MM-DD or any JS-Date-parseable string). Default to 30 days from today."),
  reason: z.string().optional().describe("Optional human note (e.g. 'Cliente prometió pagar en 30 días')."),
};

const CONFIRM_PROMESA_SCHEMA = {
  paymentIntentId: z.string().min(1).describe("PaymentIntent ID to mark as promesa (must belong to this business)."),
  expectedAt: z.string().describe("Date when cash is expected (YYYY-MM-DD or any JS-Date-parseable string). Default to 30 days from today."),
  reason: z.string().optional().describe("Optional free-text note (e.g. 'Juan prometió pagar el mes que viene')."),
};

const SETTLE_PROMESA_SCHEMA = {
  originalPaymentIntentId: z.string().min(1).describe("PaymentIntent ID that was recorded as a promesa (must belong to this business)."),
  paymentMethod: z.enum(["transferencia", "efectivo", "mp"]).describe("How the cash arrived: bank transfer, cash, or MercadoPago."),
  amount: z.number().positive().optional()
    .describe("Amount in ARS. OPTIONAL — omit to use the original promesa amount from the DB (recommended). Supply only for partial/adjusted payments. Hard ceiling: 2x the original; amounts >5% over log a warning but are accepted."),
  reason: z.string().optional().describe("Optional note (e.g. 'Juan transfirió el 26/06')."),
};

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers the six money-path tools on the given server.
 * Called only when a verified businessId is available from the auth gate.
 *
 * The injected SalesBackend covers the three hardcoded write tools
 * (register_sale, register_movement, return_sale). The promesa tools
 * (register_promesa_sale, confirm_promesa_payment, settle_promesa_payment)
 * continue to use the existing promesa-mutations handlers directly, as they
 * already have their own createPromesaBackend() seam.
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
    (args) => backend.registerMovement({ businessId, ...args }),
  );

  server.registerTool(
    "register_promesa_sale",
    {
      title: "Register promesa sale",
      description:
        "Use this when the owner says a customer will pay later (promesa / accounts-receivable). " +
        "Creates a deferred-payment sale (promesa / accounts-receivable). Atomically creates " +
        "Sale + SaleItems + inventory decrements + Invoice + PaymentIntent (metodo='promesa'). " +
        "customerId MUST be a real customer in this business — foreign IDs return isError. " +
        "productId values MUST belong to this business — foreign IDs return isError. " +
        "Idempotent: the same (customerId, items, expectedAt) deduplicates. " +
        "Returns paymentIntentId, saleId, and grandTotal on success. " +
        "For sales paid via a MercadoPago link, use open_payment_link_wizard instead.",
      inputSchema: REGISTER_PROMESA_SCHEMA,
      // Standard MCP tool annotations — https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    (args) => handleRegisterPromesaSale(businessId, args),
  );

  server.registerTool(
    "confirm_promesa_payment",
    {
      title: "Confirm promesa payment",
      description:
        "Use this when a PaymentIntent already exists and the owner says the customer will pay later — marks that PI as a promesa. " +
        "Do NOT use to create a new promesa sale (use `register_promesa_sale`) or to record cash received (use `settle_promesa_payment`). " +
        "Marks an existing pending PaymentIntent as a promesa de pago (deferred payment). " +
        "On success: CashMovement created (transactional). Best-effort (failures logged, not surfaced): " +
        "WhatsApp receipt, owner notification, Andreani shipment if shipping required. " +
        "paymentIntentId MUST belong to this business — foreign IDs return isError. " +
        "Idempotent: an already-confirmed intent returns replayed=true without error.",
      inputSchema: CONFIRM_PROMESA_SCHEMA,
      // Standard MCP tool annotations — https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    (args) => handleConfirmPromesa(businessId, args),
  );

  server.registerTool(
    "settle_promesa_payment",
    {
      title: "Settle promesa payment",
      description:
        "Records that the deferred cash from a prior promesa actually arrived. " +
        "Use when the owner says they received payment for a promesa (e.g. 'ya me pagó'). " +
        "Creates a real CashMovement (type=in) linked to the original PaymentIntent. " +
        "originalPaymentIntentId MUST belong to this business — foreign IDs return isError. " +
        "Idempotent: duplicate calls return replayed=true with the same cashMovementId.",
      inputSchema: SETTLE_PROMESA_SCHEMA,
      // Standard MCP tool annotations — https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    (args) => handleSettlePromesa(businessId, args),
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
        "MONEY/INVENTORY: this is a destructive, irreversible operation — confirm intent before calling. " +
        "Returns { returned, summary } on success. Idempotent: same (count, cutoffHours) within the " +
        "same hour deduplicates.",
      inputSchema: {
        count: z.number().int().positive().max(10).default(1)
          .describe("Number of recent sales to reverse (max 10, default 1)."),
        cutoffHours: z.number().positive().max(48).default(24)
          .describe("Only consider sales within the last N hours (max 48, default 24)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    (args) => backend.returnSale({ businessId, ...args }),
  );
}
