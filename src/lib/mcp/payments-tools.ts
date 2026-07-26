// src/lib/mcp/payments-tools.ts — Velora payments MCP tool registrations.
//
// Registers one tenant-scoped tool on a McpServer instance:
//   - get_payment_intent_status : Velora PaymentIntent-level status; accepts paymentIntentId OR
//                                 customer name; returns status, method, amount, intent id.
//
// NOTE: mp_create_preference and mp_payment_status were removed (2026-06-06).
// They created/polled a bare MercadoPago preference with no Velora PaymentIntent — the
// webhook could never confirm them, making them a dead-end for the e2e commerce model.
// Tracked cobros use the PaymentIntent path (create_payment_link → webhook → PaymentIntent).
// The backend port/adapter methods (createPreference, getMpPaymentStatus) remain in
// payments-backend.* for future reuse when the tracked wizard tool is built.
//
// These tools require a resolved businessId (from the auth gate) and are only
// registered when one is provided. Pure tools (validate_cuit)
// live in server.ts and are always registered regardless of businessId.
//
// Tenant isolation: businessId ALWAYS comes from the closure — never from tool input.
//
// Backend decoupling:
//   The optional `backend` parameter decouples these tools from the Velora implementation.
//   Omitting it (the default) selects the active backend via createPaymentsBackend() which
//   reads PAYMENTS_BACKEND env (default "velora") — zero behavioural change for existing callers.
//
// References:
//   getPaymentProvider             — payment-provider.ts (Velora provider adapter factory)
//   resolveCustomerIdByName        — payments-agent-helpers.ts (fuzzy customer name → id)
//   prisma.paymentIntent           — Velora PaymentIntent table (intent-level status query)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { PaymentsBackend } from "./_lib/payments-backend.port";
import { createPaymentsBackend } from "./_lib/payments-backend.factory";
import {
  handleOpenPaymentLinkWizard,
  handleCreateTrackedPaymentLink,
} from "./_lib/payment-link-mutations";
import { PAYMENT_LINK_WIZARD_HTML } from "./widgets/generated/payment-link-wizard.html";
import { registerPendingOrdersRenderTool } from "./_lib/pending-orders-render";
import { registerCobroStatusRenderTool } from "./_lib/cobro-status-render";
import { registerDeliveryReceiptRenderTool } from "./_lib/delivery-receipt-render";

/** Canonical ui:// URI for the authored payment-link wizard resource. */
const WIZARD_RESOURCE_URI = "ui://payment-link-wizard";

// ── Shared schema: catalog-tied line item (C-2 — items required, no bare-amount) ─
const WIZARD_ITEM_SCHEMA = z.object({
  productId: z.string().min(1).describe("Product ID — must belong to this business."),
  quantity: z.number().int().positive().describe("Units (positive integer)."),
  unitPriceOverride: z.number().positive().optional()
    .describe("Optional negotiated unit price. When omitted, the DB price is used."),
});

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers get_payment_intent_status on the given server.
 * Called only when a verified businessId is available from the auth gate.
 *
 * @param backend - Optional PaymentsBackend override. Defaults to createPaymentsBackend()
 *   which reads PAYMENTS_BACKEND env (default "velora"). Pass an explicit instance in
 *   tests or when injecting an alternative backend — server.ts call site is unchanged.
 */
export function registerPaymentsTools(
  server: McpServer,
  businessId: string,
  backend: PaymentsBackend = createPaymentsBackend(),
): void {
  // ── Tool: get_payment_intent_status ───────────────────────────────────────
  server.registerTool(
    "get_payment_intent_status",
    {
      title: "Get payment intent status",
      description:
        "Use this when the owner asks whether a payment was received or approved. " +
        "Checks the current status of a Velora PaymentIntent. Accepts a paymentIntentId OR " +
        "a customer name — when a name is provided, resolves the most recent payment intent " +
        "for that customer. Returns status (pending | approved | rejected | refunded | disputed | error), the " +
        "paymentIntentId, and the providerRef when available. " +
        "This reads Velora's PaymentIntent table via the configured payment provider adapter. " +
        "Returns isError: true when neither paymentIntentId nor customerName is provided, " +
        "when the customer or intent is not found, or on infrastructure failure. " +
        "Returns JSON status — if the owner wants a visual status card, use open_cobro_status instead.",
      inputSchema: {
        paymentIntentId: z
          .string()
          .optional()
          .describe(
            "Velora PaymentIntent id returned by create_payment_link. " +
            "Optional when customerName is provided.",
          ),
        customerName: z
          .string()
          .optional()
          .describe(
            "Customer name (fuzzy match). When provided without paymentIntentId, resolves " +
            "the most recent PaymentIntent for that customer in this business.",
          ),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      // openWorldHint: true — the MercadoPago path calls MP's external API to fetch live payment status.
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const result = await backend.getPaymentStatus({
        tenantId: businessId,
        paymentIntentId: args.paymentIntentId,
        customerName: args.customerName,
      });

      if (result.domainError) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: result.domainError,
                ...(result.paymentIntentId ? { paymentIntentId: result.paymentIntentId } : {}),
                message: result.errorMessage,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              paymentIntentId: result.paymentIntentId,
              status: result.status,
              providerRef: result.providerRef ?? null,
              currency: "ARS",
            }),
          },
        ],
      };
    },
  );

  // ── Resource: ui://payment-link-wizard (authored MCP App widget) ────────────
  // Self-contained HTML (React widget bundled by scripts/build-widget.mjs). The
  // host renders it fullscreen in a sandboxed iframe. Static — no tenant data.
  registerAppResource(
    server,
    "Asistente de cobro",
    WIZARD_RESOURCE_URI,
    // _meta.ui.csp: official MCP Apps sandbox CSP field. Self-contained → no external origins.
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: PAYMENT_LINK_WIZARD_HTML }],
    }),
  );

  // ── Tool: open_payment_link_wizard (RENDER — side-effect-free) ──────────────
  // registerAppTool links the tool to the ui:// resource via _meta.ui.resourceUri,
  // so the host opens the wizard widget pre-filled with this tool's input.
  registerAppTool(
    server,
    "open_payment_link_wizard",
    {
      title: "Open payment link wizard",
      description:
        "Use this when the owner wants to charge a customer via MercadoPago — opens a visual wizard to review and confirm the cobro before any money moves. " +
        "Opens the payment-link wizard — an authored graphical form pre-filled with the cobro " +
        "the owner dictated, for them to review/correct (including editing quantities) and confirm " +
        "before any money moves. BEFORE calling this you MUST resolve the real IDs: (1) find_customer " +
        "→ customerId, (2) query_catalog → each productId. The tool resolves product names + catalog " +
        "prices itself and computes the total. Side-effect-free (no sale, no charge); the cobro only " +
        "executes when the owner confirms inside the wizard (which calls create_tracked_payment_link).",
      // openai/outputTemplate = ChatGPT's primary render key; ui.resourceUri = MCP-Apps standard. Same ui:// target.
      _meta: { ui: { resourceUri: WIZARD_RESOURCE_URI }, "openai/outputTemplate": WIZARD_RESOURCE_URI },
      // outputSchema: ChatGPT renders the widget only when the tool declares it (OpenAI quickstart).
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {
        description: z.string().min(1).describe("Cobro description (e.g. '3 alfajores')."),
        customerId: z.string().min(1).optional()
          .describe("Customer ID — resolve via find_customer BEFORE calling. Optional: when omitted the wizard opens with an empty customer picker so the owner can select one before confirming."),
        items: z.array(WIZARD_ITEM_SCHEMA).min(1)
          .describe("Line items (productId + quantity) — resolve via query_catalog BEFORE calling. At least one required."),
      },
      // Side-effect-free render tool — reads the catalog only. Read-only per MCP ToolAnnotations.
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => handleOpenPaymentLinkWizard(businessId, args, backend),
  );

  // ── open_pending_orders (RENDER + resource, READ-ONLY) ───────────────────────
  // Extracted to _lib/pending-orders-render.ts (300-line budget).
  registerPendingOrdersRenderTool(server, businessId, backend);

  // ── open_cobro_status (RENDER + resource, READ-ONLY) ─────────────────────────
  // Extracted to _lib/cobro-status-render.ts (300-line budget).
  registerCobroStatusRenderTool(server, businessId, backend);

  // ── open_delivery_receipt (RENDER + resource, READ-ONLY) ──────────────────────
  // Step 5 of the commerce flow: comprobante/factura + envío after payment confirmed.
  // Extracted to _lib/delivery-receipt-render.ts (300-line budget).
  registerDeliveryReceiptRenderTool(server, businessId, backend);

  // ── Tool: create_tracked_payment_link (WRITE — gated money path) ────────────
  // The cobro the wizard confirms: atomic Sale+Invoice+PaymentIntent, then a real
  // MercadoPago Checkout Pro link (3-day expiry). Human-in-the-loop is the wizard's
  // Confirmar button; destructiveHint signals the host to treat it as a money op.
  server.registerTool(
    "create_tracked_payment_link",
    {
      title: "Create tracked payment link",
      description:
        "This tool is invoked by the payment-link wizard's Confirmar button — do NOT call it directly from chat; use `open_payment_link_wizard` first, which supplies the idempotencyKey automatically. " +
        "Creates a tracked MercadoPago payment link for a catalog-tied cobro: atomically records " +
        "the Sale + Invoice + PaymentIntent, then generates a real Checkout Pro link (default 3-day " +
        "expiry). MONEY: real and irreversible. " +
        "customerId and items are required (catalog-tied; the total is derived from items × DB price, " +
        "never from a model-supplied amount). idempotencyKey is generated by the wizard when the form opens — do not supply this value manually. " +
        "Returns the payment link in structuredContent.",
      inputSchema: {
        customerId: z.string().min(1).describe("Customer ID — must belong to this business."),
        items: z.array(WIZARD_ITEM_SCHEMA).min(1).describe("Line items. At least one required."),
        description: z.string().min(1).describe("Cobro description shown on the MP preference."),
        expiresInDays: z.number().int().min(1).max(30).optional()
          .describe("Link lifetime in days (1–30). Defaults to 3."),
        idempotencyKey: z.string().min(1)
          .describe("Stable UUID generated by the wizard when the form opens. Supplied automatically — do not construct this value manually."),
      },
      // Money-destructive + idempotent (same idempotencyKey → no double charge).
      // openWorldHint: true — creates a real MercadoPago Checkout Pro preference (→ external MP API).
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
    },
    (args) => handleCreateTrackedPaymentLink(businessId, args, backend),
  );
}
