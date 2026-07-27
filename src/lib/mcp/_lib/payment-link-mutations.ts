// payment-link-mutations.ts — handlers for the payment-link wizard MCP tools.
//
//   open_payment_link_wizard    (RENDER) : side-effect-free; validates the
//        pre-resolved inputs and returns the wizard ui:// pointer + prefill.
//   create_tracked_payment_link (WRITE)  : thin tool adapter. Delegates all
//        money logic to PaymentsBackend.createTrackedPaymentLink, then maps
//        the domain Result → MCP response. businessId always from closure.
//
// SECURITY: businessId ALWAYS from the closure (server.ts), NEVER from tool input.
// MONEY (NABAOS): the charged total is recomputed server-side from the line items
//   inside the adapter (velora-payment-link.ts). No model-supplied total reaches
//   the payment provider.
//
// See velora-payment-link.ts for the verbatim money logic.

import { cloudLog } from "@/lib/cloud-logger";
import type { PaymentsBackend } from "./payments-backend.port";
import { nextSeq } from "./election-seq";

// ── Response shape (mirrors sales-mutations errResponse) ────────────────────────

type McpToolResponse = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
};

function errResp(code: string, message: string): McpToolResponse {
  return { content: [{ type: "text", text: JSON.stringify({ error: code, message }) }], isError: true };
}

// GATE-3 safe-by-default: the link URL goes ONLY in structuredContent (the widget
// reads it). The content text carries NO URL/amount the model could mistype. If
// GATE-3 later proves structuredContent is hidden from the model on the target
// host, this stays correct; if it proves surfaced, no sensitive value leaks via
// content. See payment-link-wizard ledger H-3.
function successResp(checkoutUrl: string | null, paymentIntentId: string, amountARS: number): McpToolResponse {
  return {
    content: [{ type: "text", text: "Listo, generé el link de cobro." }],
    structuredContent: { paymentLinkUrl: checkoutUrl ?? null, paymentIntentId, amountARS, currency: "ARS" },
  };
}

// ── Render tool: open_payment_link_wizard ──────────────────────────────────────

export interface OpenWizardArgs {
  description: string;
  /** Optional: when omitted the wizard opens with an empty customer picker. */
  customerId?: string;
  items: Array<{ productId: string; quantity: number; unitPriceOverride?: number }>;
}

/** Side-effect-free READ. When customerId is provided, delegates catalog + customer lookups
 *  to the PaymentsBackend port (tenant-scoped) and returns a fully-resolved wizard prefill.
 *  When customerId is absent (e.g. called from catalog-selector), resolves only the catalog
 *  items and returns an empty customer prefill — the owner picks the customer in-widget.
 *  NABAOS: the displayed total is derived from catalog prices, never from a model-supplied amount.
 *  items REQUIRED. Errors if any productId is not found in the catalog
 *  (do NOT silently fall back to price 0). */
export async function handleOpenPaymentLinkWizard(businessId: string, args: OpenWizardArgs, backend: PaymentsBackend): Promise<McpToolResponse> {
  if (!args.items || args.items.length === 0) return errResp("validation", "items es requerido. Resolvé los productos con query_catalog antes de abrir el asistente.");

  const result = await backend.resolveWizardPrefill({
    tenantId: businessId,
    description: args.description,
    // Empty string when no customerId — adapter resolves items only and returns an
    // empty-customer prefill (no customer_not_found error for the no-customer path).
    customerId: args.customerId?.trim() ?? "",
    items: args.items,
  });

  if (result.domainError) {
    return errResp(result.domainError, result.errorMessage);
  }

  // The ui://payment-link-wizard resourceUri is attached by registerAppTool at
  // registration time (canonical ext-apps _meta.ui.resourceUri) — not here.
  return {
    content: [{ type: "text", text: "Abrí el asistente de cobro para revisar y confirmar." }],
    structuredContent: {
      // createdAt is the instance-supersession election key (Velora display
      // extension, not a business date) — same convention as
      // cobro-status-render.ts / delivery-receipt-render.ts. seq tie-breaks ties.
      prefill: { ...result.prefill, createdAt: Date.now(), seq: nextSeq() },
    },
  };
}

// ── Write tool: create_tracked_payment_link ────────────────────────────────────

export interface CreateTrackedLinkArgs {
  customerId: string;
  items: Array<{ productId: string; quantity: number; unitPriceOverride?: number }>;
  description: string;
  expiresInDays?: number;
  /** Widget-generated stable UUID (form-open). NEVER model-supplied. */
  idempotencyKey: string;
}

/**
 * Thin tool adapter for create_tracked_payment_link.
 * Delegates all money logic to backend.createTrackedPaymentLink (PaymentsBackend port),
 * then maps the domain Result to the MCP response shape.
 *
 * @param businessId  - tenant identifier from the auth-gate closure. NEVER from args.
 * @param args        - validated tool arguments (Zod gate at MCP boundary).
 * @param backend     - injected PaymentsBackend (defaults to createPaymentsBackend() via payments-tools.ts).
 */
export async function handleCreateTrackedPaymentLink(
  businessId: string,
  args: CreateTrackedLinkArgs,
  backend: PaymentsBackend,
): Promise<McpToolResponse> {
  // ── Validation (defensive — Zod also gates at the MCP boundary) ──────────
  if (!args.customerId?.trim()) return errResp("validation", "customerId es requerido.");
  if (!args.items || args.items.length === 0) return errResp("validation", "items es requerido (al menos un producto).");
  if (!args.idempotencyKey?.trim()) return errResp("validation", "idempotencyKey ausente — lo genera el asistente, no el modelo.");
  const expiresInDays = args.expiresInDays ?? 3;
  if (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
    return errResp("validation", "expiresInDays debe estar entre 1 y 30 días.");
  }

  try {
    // ── Delegate all money logic to the port ─────────────────────────────────
    const result = await backend.createTrackedPaymentLink({
      tenantId: businessId,
      customerId: args.customerId,
      items: args.items,
      description: args.description,
      expiresInDays,
      idempotencyKey: args.idempotencyKey,
    });

    // ── Domain Result → MCP response ─────────────────────────────────────────
    if ("domainError" in result && result.domainError) {
      return errResp(result.domainError, result.errorMessage ?? result.domainError);
    }
    if (!("domainError" in result)) {
      return successResp(result.paymentLinkUrl, result.paymentIntentId, result.amountARS);
    }
    // domainError is present but falsy — should not happen; surface as generic error.
    return errResp("mp_api_error", "No se pudo crear el link de cobro.");
  } catch (err) {
    cloudLog({
      severity: "ERROR", component: "A2A", action: "PAYMENT_WIZARD_WRITE_TOOL_ERROR",
      a2a_transfer: false, message: "create_tracked_payment_link threw",
      businessId, data: { error: err instanceof Error ? err.message : String(err) },
    });
    return errResp("mp_api_error", "No se pudo crear el link de cobro. Intentá de nuevo o contactá soporte.");
  }
}
