// src/lib/mcp/_lib/promesa-backend.port.ts — Backend-agnostic port for promesa MCP tools.
//
// Decouples the 3 promesa tools from Velora's concrete payment-intent use-case layer.
// A future adapter (e.g. a different payments backend) implements this interface
// and requires ZERO changes to sales-tools.ts or the MCP server.
//
// Design mirrors catalog-backend.port.ts / fiscal-backend.port.ts:
//   port (this file) → adapter (velora-promesa.adapter.ts) → factory (promesa-backend.factory.ts)
//
// tenantId is opaque here — the Velora adapter maps it to businessId internally
// so the port name doesn't hard-wire Velora's domain vocabulary.
//
// Input/output types re-export the existing use-case types DIRECTLY — no new shapes
// invented. The port is a seam, not a full domain model.
//
// HARD CONSTRAINTS (money-path — do NOT relax):
//   - runPostConfirmSideEffects (WhatsApp + Andreani + fiscal receipt) is fire-and-forget
//     INSIDE the use-cases. The port contract is ONLY the use-case return value.
//   - $transaction boundaries (Sale/SaleItem/Invoice/PaymentIntent/CashMovement +
//     inventory decrement) are defined in the use-cases — untouched here.
//   - settle's audit error-propagation (recordCriticalWriteEvent throws through) is
//     preserved because the adapter delegates AS-IS.

import type { RegisterPromesaSaleResult, RegisterPromesaSaleItem } from "@/app/api/payment-intents/_lib/register-promesa-sale-use-case";
import type { ConfirmPromesaResult } from "@/app/api/payment-intents/_lib/confirm-promesa-use-case";
import type { SettlePromesaResult, SettlePaymentMethod } from "@/app/api/payment-intents/_lib/settle-promesa-use-case";

// Re-export use-case output types as port types — one canonical source of truth.
// Input types are defined below with tenantId as the opaque tenant field.
export type {
  RegisterPromesaSaleItem,
  RegisterPromesaSaleResult,
  ConfirmPromesaResult,
  SettlePaymentMethod,
  SettlePromesaResult,
};

// ── Per-method input types (tenantId replaces businessId) ────────────────────
// These mirror the use-case input types exactly, with tenantId as the opaque
// tenant field (mapped to businessId by the adapter).

export interface PromesaRegisterInput {
  tenantId: string;
  actorUserId: string;
  customerId: string;
  items: RegisterPromesaSaleItem[];
  expectedAt: Date;
  reason?: string;
}

export interface PromesaConfirmInput {
  tenantId: string;
  paymentIntentId: string;
  actorUserId: string;
  expectedAt: Date;
  reason?: string;
}

export interface PromesaSettleInput {
  tenantId: string;
  originalPaymentIntentId: string;
  actorUserId: string;
  paymentMethod: SettlePaymentMethod;
  /** When omitted the use-case uses PI.monto from the DB (DB-first default). */
  amount?: number;
  reason?: string;
}

/**
 * Backend-agnostic promesa port for the MCP sales tool pack.
 *
 * Every method maps to one MCP tool:
 *   registerPromesaSale    → register_promesa_sale
 *   confirmPromesaPayment  → confirm_promesa_payment
 *   settlePromesaPayment   → settle_promesa_payment
 *
 * Throw an Error for unexpected failures — promesa-mutations.ts catches thrown
 * errors and converts them to MCP isError responses.
 *
 * Tenant isolation is enforced by each adapter via the opaque tenantId field.
 *
 * CRITICAL: Do NOT await, restructure, or lift runPostConfirmSideEffects out of
 * the use-cases into this port. The post-confirm side-effect chain (WhatsApp +
 * Andreani + fiscal receipt) is fire-and-forget INSIDE the use-cases and must
 * remain there.
 */
export interface PromesaBackend {
  registerPromesaSale(input: PromesaRegisterInput): Promise<RegisterPromesaSaleResult>;
  confirmPromesaPayment(input: PromesaConfirmInput): Promise<ConfirmPromesaResult>;
  settlePromesaPayment(input: PromesaSettleInput): Promise<SettlePromesaResult>;
}
