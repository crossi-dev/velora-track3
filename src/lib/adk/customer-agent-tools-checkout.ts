import "server-only";
// customer-agent-tools-checkout.ts — Checkout tools for the Customer Agent.
//
// Split from customer-agent-tools-a2a.ts to stay under the 300-line server/lib limit.
// Contains the two deterministic checkout tools:
//   quote_shipping       → resolveShippingQuote() skill (deterministic, no LLM agent)
//   create_payment_link  → builds the request from the authoritative cart in
//                          session.state; the LLM never composes amounts/quantities.
//
// Industry standard 2026: deterministic tools own cart/pricing/shipping; the LLM
// orchestrates but never computes money or invents stock.
//   https://stripe.com/guides/agentic-commerce · https://shopify.dev/docs/agents

import { createHash } from "crypto";
import { FunctionTool } from "@google/adk";
import type { Context } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { sendMessage, A2AClientError } from "@/lib/a2a-client";
import { signAgentAssertion } from "@/lib/agent-identity";
import { deriveA2AKey } from "@/app/api/a2a/jsonrpc/_lib/handle-rpc";
import { cloudLog } from "@/lib/cloud-logger";
import { PAYMENTS_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import { resolveShippingQuote } from "@/lib/shipping-quote";
import { readOrder } from "./customer-agent-tools-order";
import type { CustomerAgentToolContext } from "./customer-agent-tools";

const QUOTE_SHIPPING_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    postalCode: {
      type: Type.STRING,
      description:
        "Destination postal code (CP). Optional — if omitted, the customer's saved CP is used.",
    },
  },
  required: [],
};

const CREATE_PAYMENT_LINK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    confirmed: {
      type: Type.BOOLEAN,
      description: "true once the customer confirmed the order shown in the review summary.",
    },
  },
  required: [],
};

// ── quote_shipping ──────────────────────────────────────────────────────────────

/**
 * Returns the exact shipping cost via the deterministic resolveShippingQuote skill
 * (DB origin/destination CP + structured shipment.quote). NOT a nested LLM agent —
 * a shipping cost is a deterministic computation, so it belongs in a tool/skill,
 * not a sub-agent (was the main 60s-timeout sink).
 */
export function createQuoteShippingTool(ctx: CustomerAgentToolContext) {
  return new FunctionTool({
    name: "quote_shipping",
    description:
      "Gets the exact shipping cost to the customer's address. Deterministic — never guess a cost. " +
      "Call after the customer gives their address/postal code. Optionally pass the destination CP.",
    parameters: QUOTE_SHIPPING_SCHEMA,
    execute: async (args: unknown, tool_context?: Context) => {
      const { postalCode } = (args ?? {}) as { postalCode?: string };
      const customerId =
        (tool_context?.state.get("user:customer_id") as string | undefined) ?? null;
      cloudLog({
        severity: "INFO", component: "CustomerAgent", action: "CUSTOMER_TOOL_QUOTE_SHIPPING",
        a2a_transfer: true, message: "Customer Agent → resolveShippingQuote (deterministic skill)",
        data: { businessId: ctx.businessId, hasCustomerId: !!customerId, postalCode: postalCode ?? null },
      });
      const result = await resolveShippingQuote({
        businessId: ctx.businessId,
        customerId,
        inlinePostalCode: postalCode ?? null,
      });
      if (!result.ok) {
        const msg =
          result.reason === "missing_destination_postal_code"
            ? "Necesito tu código postal para cotizar el envío. ¿Me lo pasás?"
            : result.reason === "missing_origin_postal_code"
              ? "El negocio todavía no configuró su código postal de origen — le aviso al dueño."
              : "No pude cotizar el envío en este momento.";
        return { error: msg, reason: result.reason };
      }
      // Store the quoted cost so create_payment_link can pass it through and
      // Payments does NOT re-fetch shipping (removes the double Logística call).
      tool_context?.state.set("shipping_cost", result.costARS);
      return { costARS: result.costARS };
    },
  });
}

// ── Stable turnId derivation ────────────────────────────────────────────────────
//
// A Cloud Tasks task can be retried (at-least-once delivery). Each retry calls
// runCustomerAgent → create_payment_link tool → A2A to Payments. If turnId is a
// fresh randomUUID() on every RPC invocation, handle-payments-rpc.ts feeds a
// different idempotency key into buildLinkIdempotencyKey on every retry →
// duplicate PaymentIntent rows → double charge.
//
// Fix: derive a 32-char hex string from the inbound WhatsApp messageId (stable
// across retries of the same Cloud Tasks task). The messageId is unique per
// customer message, so different orders get different keys; retries of the same
// message produce the same key → the second registerSaleWithPaymentLinkUseCase
// call hits the existing row (no second PaymentIntent).
//
// The derived value is passed as contextId in the A2A sendMessage call.
// handle-payments-rpc.ts uses it as turnId when present, falling back to
// randomUUID() for the owner fast-path (which passes its own turnId).
export function deriveTurnIdFromMessageId(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex").slice(0, 32);
}

// ── create_payment_link ─────────────────────────────────────────────────────────

/**
 * Creates the payment link for the order held in session.state (set deterministically
 * by update_order_item). The LLM does NOT pass amounts or quantities — they come from
 * the authoritative cart, so "3" can never become "33". Payments still recomputes the
 * total server-side from DB prices. Passes the already-quoted shipping cost so Payments
 * does not re-fetch it.
 */
export function createPaymentLinkForCustomerTool(ctx: CustomerAgentToolContext) {
  const agentUrl = `${ctx.appUrl}/api/agents/payments/jsonrpc`;
  const a2aSecret = process.env.A2A_SECRET ?? "";
  const apiKey = a2aSecret ? deriveA2AKey(a2aSecret, ctx.businessId) : undefined;

  return new FunctionTool({
    name: "create_payment_link",
    description:
      "Creates the payment link for the order the customer already confirmed in the review step. " +
      "Reads the order from the cart (built via update_order_item) — you do NOT pass amounts or " +
      "quantities. Call only after showing the review summary and getting confirmation.",
    parameters: CREATE_PAYMENT_LINK_SCHEMA,
    execute: async (args: unknown, tool_context?: Context) => {
      // H1 fix (2026-05-29): require explicit customer confirmation before creating
      // the payment link. The LLM must show the order summary and get confirmed=true
      // before calling this tool. Without this gate the LLM was calling
      // create_payment_link immediately after update_order_item, skipping the review
      // step and creating payment intents for unconfirmed orders.
      const { confirmed } = (args ?? {}) as { confirmed?: boolean };
      if (confirmed !== true) {
        return {
          error:
            "Mostrá el resumen al cliente y pedí confirmación antes de crear el link. " +
            "Llamá a esta herramienta con confirmed=true solo cuando el cliente acepte.",
        };
      }
      const order = readOrder(tool_context);
      if (!order.items.length) {
        return { error: "No hay items en el pedido todavía. Usá update_order_item antes de cobrar." };
      }
      const customerName =
        (tool_context?.state.get("user:customer_name") as string | undefined) ?? "";
      // Pass customerId explicitly so the Payments agent does not need to fuzzy-match
      // by phone number (which is what user:customer_name contains for new customers).
      // Without this annotation the Payments agent cannot look up Customer.postalCode
      // and resolveShippingQuote returns missing_destination_postal_code.
      const customerId =
        (tool_context?.state.get("user:customer_id") as string | undefined) ?? null;
      const shipping =
        (tool_context?.state.get("shipping_cost") as number | undefined) ?? null;

      // precio_unitario is intentionally omitted from the A2A message so the
      // Payments LLM cannot forward it as unitPriceOverride. Prices are always
      // recomputed from the DB in register-sale-with-payment-link-use-case.ts.
      // The subtotal/total below are display-only context for the Payments LLM.
      const lines = order.items
        .map((i) => `- ${i.name} | productId=${i.productId} | cantidad=${i.qty}`)
        .join("\n");
      const grandTotal = order.subtotal + (shipping ?? 0);
      // preQuotedShippingCostARS tells the Payments create_payment_link tool to skip
      // resolveShippingQuote and use this value directly. Prevents the double Logística
      // call and the missing_destination_postal_code error for newly-created customers
      // whose postalCode may not yet be visible to the Payments agent's DB read.
      // jd: sanitize customerName before injecting into the A2A message to prevent
      // prompt-injection via adversarial customer names (OWASP LLM01).
      const safeCustomerName = (customerName ?? "")
        .replace(/[\r\n\t\0]+/g, " ")
        .slice(0, 100);
      const fullMessage =
        `businessId: ${ctx.businessId}\n` +
        (customerId ? `(customerId="${customerId}")\n` : "") +
        `Crear link de pago para este pedido. Usá EXACTAMENTE estas cantidades y productId — no recalcules ni reinterpretes:\n` +
        `Cliente: ${safeCustomerName || "(sin nombre)"}\n` +
        `Items:\n${lines}\n` +
        `Subtotal productos: ${order.subtotal}\n` +
        (shipping !== null
          ? `Envío pre-cotizado: ${shipping}\npreQuotedShippingCostARS: ${shipping}\n`
          : "") +
        `Total: ${grandTotal}`;

      cloudLog({
        severity: "INFO", component: "CustomerAgent", action: "CUSTOMER_TOOL_PAYMENT_LINK",
        a2a_transfer: true, message: `Customer Agent → Payments A2A: create_payment_link`,
        data: { businessId: ctx.businessId, itemCount: order.items.length, subtotal: order.subtotal, shipping },
      });
      // Derive a stable contextId from the inbound messageId so that Cloud Tasks
      // retries of the same task produce the same idempotency key inside
      // handle-payments-rpc.ts (no duplicate PaymentIntent / double-charge).
      // Falls back to undefined (no contextId) when not on the wpp-inbound path
      // (e.g. PATH A Supervisor delegation), in which case the Payments RPC
      // generates its own randomUUID() — that path is not retry-vulnerable.
      const stableContextId = ctx.inboundMessageId
        ? deriveTurnIdFromMessageId(ctx.inboundMessageId)
        : undefined;

      try {
        const reply = await sendMessage(agentUrl, fullMessage, {
          apiKey,
          agentAssertionFactory: () => signAgentAssertion("customer", "payments"),
          timeoutMs: PAYMENTS_AGENT_TIMEOUT_MS,
          ...(stableContextId ? { contextId: stableContextId } : {}),
        });
        // Clear the cart so a follow-up order starts clean (no stale contamination).
        tool_context?.state.set("order", { items: [], subtotal: 0 });
        tool_context?.state.set("shipping_cost", null);
        return { result: reply.text ?? "Sin respuesta del Payments Agent." };
      } catch (err) {
        const errMsg = err instanceof A2AClientError ? err.message : "Error al crear link de pago.";
        cloudLog({
          severity: "ERROR", component: "CustomerAgent", action: "CUSTOMER_TOOL_PAYMENT_LINK_ERROR",
          a2a_transfer: false, message: errMsg,
          data: { businessId: ctx.businessId },
        });
        return { error: errMsg };
      }
    },
  });
}
