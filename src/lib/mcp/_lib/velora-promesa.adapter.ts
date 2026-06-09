// src/lib/mcp/_lib/velora-promesa.adapter.ts — Velora concrete implementation of PromesaBackend.
//
// Delegates DIRECTLY to the 3 existing use-cases, called EXACTLY as
// promesa-mutations.ts does today. Pure restructure — zero behavioral change.
// tenantId is mapped to businessId before every use-case call.
//
// Design source: velora-catalog.adapter.ts (composition over inheritance).
// The adapter is a thin delegation layer: it doesn't add logic, it translates shapes.
//
// HARD CONSTRAINTS (money-path — do NOT relax):
//   - runPostConfirmSideEffects (WhatsApp + Andreani + fiscal receipt) is fire-and-forget
//     INSIDE the use-cases. This adapter calls the use-cases AS-IS and does NOT await,
//     restructure, or lift any post-confirm side effect.
//   - $transaction boundaries (Sale/SaleItem/Invoice/PaymentIntent/CashMovement +
//     inventory decrement) are defined in the use-cases — use-case bodies untouched.
//   - settle's audit error-propagation: settle-promesa-use-case.ts lets
//     recordCriticalWriteEvent throw through — this adapter delegates AS-IS and
//     preserves that behavior.
//   - The use-cases are NOT moved out of @/app/api/payment-intents/_lib/ —
//     existing API routes import them from there.

import type {
  PromesaBackend,
  PromesaRegisterInput,
  PromesaConfirmInput,
  PromesaSettleInput,
  RegisterPromesaSaleResult,
  ConfirmPromesaResult,
  SettlePromesaResult,
} from "./promesa-backend.port";
import { registerPromesaSaleUseCase } from "@/app/api/payment-intents/_lib/register-promesa-sale-use-case";
import { confirmPromesaPaymentUseCase } from "@/app/api/payment-intents/_lib/confirm-promesa-use-case";
import { settlePromesaUseCase } from "@/app/api/payment-intents/_lib/settle-promesa-use-case";

export class VeloraPromesaAdapter implements PromesaBackend {
  async registerPromesaSale(input: PromesaRegisterInput): Promise<RegisterPromesaSaleResult> {
    const { tenantId: businessId, actorUserId, customerId, items, expectedAt, reason } = input;
    return registerPromesaSaleUseCase({
      businessId,
      actorUserId,
      customerId,
      items,
      expectedAt,
      reason,
    });
  }

  async confirmPromesaPayment(input: PromesaConfirmInput): Promise<ConfirmPromesaResult> {
    const { tenantId: businessId, paymentIntentId, actorUserId, expectedAt, reason } = input;
    return confirmPromesaPaymentUseCase({
      paymentIntentId,
      businessId,
      actorUserId,
      expectedAt,
      reason,
    });
  }

  async settlePromesaPayment(input: PromesaSettleInput): Promise<SettlePromesaResult> {
    const { tenantId: businessId, originalPaymentIntentId, actorUserId, paymentMethod, amount, reason } = input;
    return settlePromesaUseCase({
      originalPaymentIntentId,
      businessId,
      actorUserId,
      paymentMethod,
      amount,
      reason,
    });
  }
}
