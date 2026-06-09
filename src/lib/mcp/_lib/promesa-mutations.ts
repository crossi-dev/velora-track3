// src/lib/mcp/_lib/promesa-mutations.ts — Handlers for sales-tools.ts (Batch 4 money).
//
// register_promesa_sale : creates Sale + Invoice + PaymentIntent (deferred) via
//                         backend.registerPromesaSale → VeloraPromesaAdapter → registerPromesaSaleUseCase.
// confirm_promesa_payment : marks an existing pending PaymentIntent as confirmed
//                           (promesa) via backend.confirmPromesaPayment → confirmPromesaPaymentUseCase.
// settle_promesa_payment  : records that deferred cash arrived for a prior promesa
//                           via backend.settlePromesaPayment → settlePromesaUseCase.
//
// SECURITY: businessId ALWAYS from the closure — NEVER from tool input.
// Caller-supplied paymentIntentId is qualified by the closure businessId inside
// the use-cases (findFirst with businessId guard) — foreign IDs → not_found/isError.
//
// Backend selection:
//   PROMESA_BACKEND env var (default "velora"). Read at call time by createPromesaBackend().
//   Handlers accept an optional backend param — defaults to createPromesaBackend() so
//   the public sales-tools.ts call site is unchanged.
//
// References:
//   register-promesa-sale-use-case — src/app/api/payment-intents/_lib/register-promesa-sale-use-case.ts
//   confirm-promesa-use-case       — src/app/api/payment-intents/_lib/confirm-promesa-use-case.ts
//   settle-promesa-use-case        — src/app/api/payment-intents/_lib/settle-promesa-use-case.ts

import type { PromesaBackend, SettlePaymentMethod } from "./promesa-backend.port";
import type { RegisterPromesaSaleItem } from "@/app/api/payment-intents/_lib/register-promesa-sale-use-case";
import { createPromesaBackend } from "./promesa-backend.factory";

// ── MCP actor constant (shared with sales-mutations.ts) ───────────────────────
export const MCP_ACTOR_USER_ID = "mcp-system";

// ── Shared error response helper ──────────────────────────────────────────────

type McpToolResponse = { content: { type: "text"; text: string }[]; isError?: boolean };

export function errResponse(code: string, message: string): McpToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ code, message }) }],
    isError: true,
  };
}

// ── register_promesa_sale ──────────────────────────────────────────────────────

export interface RegisterPromesaSaleArgs {
  customerId: string;
  items: RegisterPromesaSaleItem[];
  expectedAt: string;
  reason?: string;
}

export async function handleRegisterPromesaSale(
  businessId: string,
  args: RegisterPromesaSaleArgs,
  backend: PromesaBackend = createPromesaBackend(),
): Promise<McpToolResponse> {
  try {
    if (!args.customerId?.trim()) return errResponse("REGISTER_PROMESA_VALIDATION", "customerId is required.");
    if (!args.items || args.items.length === 0) return errResponse("REGISTER_PROMESA_VALIDATION", "At least one item is required.");
    const expectedAt = new Date(args.expectedAt);
    if (isNaN(expectedAt.getTime())) return errResponse("REGISTER_PROMESA_VALIDATION", "Invalid expectedAt date. Use ISO 8601.");

    const result = await backend.registerPromesaSale({
      tenantId: businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      customerId: args.customerId.trim(),
      items: args.items,
      expectedAt,
      reason: args.reason,
    });

    if (result.outcome === "replayed") {
      return { content: [{ type: "text", text: JSON.stringify({ replayed: true, paymentIntentId: result.paymentIntentId, saleId: result.saleId }) }] };
    }
    if (result.outcome === "business_not_found") return errResponse("BUSINESS_NOT_FOUND", "Business not found.");
    if (result.outcome === "customer_not_found") return errResponse("CUSTOMER_NOT_FOUND", "Customer not found in this business.");
    if (result.outcome === "product_not_found") return errResponse("PRODUCT_NOT_FOUND", `Product not found: ${result.productId}`);
    if (result.outcome === "wrong_business") return errResponse("PRODUCT_NOT_OWNED", `Product does not belong to this business: ${result.productId}`);
    if (result.outcome === "invalid_qty") return errResponse("INVALID_QTY", `Invalid quantity for product: ${result.productId}`);
    if (result.outcome === "unit_price_out_of_range") return errResponse("PRICE_OVERRIDE_TOO_HIGH", `Price override for product ${result.productId} exceeds the allowed ceiling.`);
    if (result.outcome === "insufficient_stock") return errResponse("INSUFFICIENT_STOCK", `Insufficient stock for ${result.productName}. Available: ${result.available}.`);
    if (result.outcome === "invalid_total") return errResponse("INVALID_TOTAL", "Sale total is 0 or invalid (product price is 0). Fix the prices before registering.");
    // exhaustive guard — outcome is "created" at this point
    if (result.outcome !== "created") return errResponse("REGISTER_PROMESA_ERROR", `Unexpected outcome: ${String((result as { outcome: unknown }).outcome)}`);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          paymentIntentId: result.paymentIntentId,
          saleId: result.saleId,
          grandTotal: result.grandTotal,
        }),
      }],
    };
  } catch (err) {
    return errResponse("REGISTER_PROMESA_ERROR", err instanceof Error ? err.message : "Unknown error");
  }
}

// ── confirm_promesa_payment ────────────────────────────────────────────────────

export interface ConfirmPromesaArgs {
  paymentIntentId: string;
  expectedAt: string;
  reason?: string;
}

export async function handleConfirmPromesa(
  businessId: string,
  args: ConfirmPromesaArgs,
  backend: PromesaBackend = createPromesaBackend(),
): Promise<McpToolResponse> {
  try {
    if (!args.paymentIntentId?.trim()) return errResponse("CONFIRM_PROMESA_VALIDATION", "paymentIntentId is required.");
    const expectedAt = new Date(args.expectedAt);
    if (isNaN(expectedAt.getTime())) return errResponse("CONFIRM_PROMESA_VALIDATION", "Invalid expectedAt date. Use ISO 8601.");

    // Tenant isolation: businessId from closure is passed to the use-case which does
    // findFirst({ id: paymentIntentId, businessId }) — foreign IDs → not_found.
    const result = await backend.confirmPromesaPayment({
      tenantId: businessId,
      paymentIntentId: args.paymentIntentId.trim(),
      actorUserId: MCP_ACTOR_USER_ID,
      expectedAt,
      reason: args.reason,
    });

    if (result.outcome === "already_confirmed") {
      return { content: [{ type: "text", text: JSON.stringify({ replayed: true, paymentIntentId: result.paymentIntentId }) }] };
    }
    if (result.outcome === "not_found") return errResponse("PAYMENT_INTENT_NOT_FOUND", "PaymentIntent not found in this business.");
    if (result.outcome === "wrong_state") return errResponse("WRONG_STATE", `PaymentIntent is in state "${result.currentState}" and cannot be set to promesa.`);
    // exhaustive guard — outcome is "confirmed" at this point
    if (result.outcome !== "confirmed") return errResponse("CONFIRM_PROMESA_ERROR", `Unexpected outcome: ${String((result as { outcome: unknown }).outcome)}`);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          paymentIntentId: result.paymentIntentId,
          promesaExpectedAt: result.promesaExpectedAt.toISOString(),
        }),
      }],
    };
  } catch (err) {
    return errResponse("CONFIRM_PROMESA_ERROR", err instanceof Error ? err.message : "Unknown error");
  }
}

// ── settle_promesa_payment ─────────────────────────────────────────────────────

export interface SettlePromesaArgs {
  originalPaymentIntentId: string;
  paymentMethod: SettlePaymentMethod;
  /** When omitted the use-case uses PI.monto from the DB (DB-first default). */
  amount?: number;
  reason?: string;
}

export async function handleSettlePromesa(
  businessId: string,
  args: SettlePromesaArgs,
  backend: PromesaBackend = createPromesaBackend(),
): Promise<McpToolResponse> {
  try {
    if (!args.originalPaymentIntentId?.trim()) return errResponse("SETTLE_PROMESA_VALIDATION", "originalPaymentIntentId is required.");
    // When amount is provided it must be positive; when omitted the use-case reads PI.monto from DB.
    if (args.amount !== undefined && args.amount <= 0) return errResponse("SETTLE_PROMESA_VALIDATION", "amount must be greater than zero.");

    // Tenant isolation: businessId from closure is passed to the use-case which does
    // findFirst({ id: originalPaymentIntentId, businessId }) — foreign IDs → not_found.
    const result = await backend.settlePromesaPayment({
      tenantId: businessId,
      originalPaymentIntentId: args.originalPaymentIntentId.trim(),
      actorUserId: MCP_ACTOR_USER_ID,
      paymentMethod: args.paymentMethod,
      amount: args.amount,
      reason: args.reason,
    });

    if (result.outcome === "already_settled") {
      return { content: [{ type: "text", text: JSON.stringify({ replayed: true, cashMovementId: result.cashMovementId }) }] };
    }
    if (result.outcome === "not_found") return errResponse("PAYMENT_INTENT_NOT_FOUND", "PaymentIntent not found in this business.");
    if (result.outcome === "wrong_metodo") return errResponse("WRONG_METODO", `PaymentIntent metodo is "${result.metodo}", not "promesa".`);
    if (result.outcome === "wrong_state") return errResponse("WRONG_STATE", `PaymentIntent is in state "${result.estado}" and cannot be settled.`);
    if (result.outcome === "amount_too_large") return errResponse("AMOUNT_TOO_LARGE", "Amount exceeds 2× the original promesa amount.");
    if (result.outcome === "invalid_promesa_monto") return errResponse("INVALID_PROMESA_MONTO", "Original promesa has invalid amount (≤0). Cannot settle.");
    // exhaustive guard — outcome is "settled" at this point
    if (result.outcome !== "settled") return errResponse("SETTLE_PROMESA_ERROR", `Unexpected outcome: ${String((result as { outcome: unknown }).outcome)}`);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          cashMovementId: result.cashMovementId,
          settledAt: result.settledAt.toISOString(),
        }),
      }],
    };
  } catch (err) {
    return errResponse("SETTLE_PROMESA_ERROR", err instanceof Error ? err.message : "Unknown error");
  }
}
