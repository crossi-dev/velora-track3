// Mutation-contract entries for PaymentIntent routes (cobro QR).
//
// Split from mutation-contract-entries.ts to keep that module under the
// hard limit of 300 LOC (CLAUDE.md). Pattern mirrors
// mutation-contract-entries.supervisor.ts.

import type { MutationContractEntry } from "./mutation-contract-types";

export const PAYMENT_INTENT_MUTATION_CONTRACT = {
  "payment_intent.create": {
    actionType: "payment_intent.create",
    routeScope: "payment-intents/create",
    resourceType: "payment_intent",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
  "payment_intent.confirm": {
    actionType: "payment_intent.confirm",
    routeScope: "payment-intents/confirm",
    resourceType: "payment_intent",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
    compositeChildren: ["cash-movement.create"],
  },
  "payment_intent.refund": {
    actionType: "payment_intent.refund",
    routeScope: "payment-intents/refund",
    resourceType: "payment_intent",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
    compositeChildren: ["cash-movement.create"],
  },
  "payment_intent.cancel": {
    actionType: "payment_intent.cancel",
    routeScope: "payment-intents/cancel",
    resourceType: "payment_intent",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
  // payment link flow: owner asks Payments Agent for a Checkout Pro link.
  // Uses a different routeScope so audit events are distinguishable from
  // QR cobros even though both persist a PaymentIntent row.
  "payment_intent.create_link": {
    actionType: "payment_intent.create_link",
    routeScope: "agents/payments/jsonrpc",
    resourceType: "payment_intent",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
  // Provider webhook update: MODO (and future providers) POST a status callback.
  // System-initiated — no user session. The webhook route uses this to declare
  // its mutation clearly even though idempotency is handled by DB state check.
  "payment_intent.webhook_update": {
    actionType: "payment_intent.webhook_update",
    routeScope: "integrations/modo/webhook",
    resourceType: "payment_intent",
    requiresTrace: false,
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
  // Promesa de pago: owner records an AR accrual — cash expected later.
  // No gateway webhook, no client idempotency key — re-entrancy is guarded
  // by the DB state check inside confirmPromesaPaymentUseCase.
  "payment_intent.confirm_promesa": {
    actionType: "payment_intent.confirm_promesa",
    routeScope: "agents/payments/jsonrpc",
    resourceType: "payment_intent",
    requiresTrace: true,
    requiresIdempotency: false,
    idempotencyStrategy: "header",
    compositeChildren: ["cash-movement.create"],
  },
  // Register a one-shot Sale + Invoice + PaymentIntent (promesa) in a single atomic
  // transaction. Distinct from confirm_promesa (which confirms an EXISTING intent);
  // this action TYPE is used exclusively by registerPromesaSaleUseCase.
  "payment_intent.register_promesa_sale": {
    actionType: "payment_intent.register_promesa_sale",
    routeScope: "agents/payments/jsonrpc",
    resourceType: "payment_intent",
    requiresTrace: true,
    requiresIdempotency: false,
    idempotencyStrategy: "header",
    compositeChildren: [
      "sale.create",
      "sale-item.create",
      "inventory.decrement",
      "invoice.create",
      "cash-movement.create",
      "payment_intent.create_confirmed",
    ],
  },
  // Settle a deferred promesa de pago — records that the AR cash actually arrived.
  // Idempotency is guarded by a partial unique index on CashMovement.clientMessageId
  // ("promesa-settle-{piId}") rather than a header key.
  "payment_intent.settle_promesa": {
    actionType: "payment_intent.settle_promesa",
    routeScope: "agents/payments/jsonrpc",
    resourceType: "payment_intent",
    requiresTrace: true,
    requiresIdempotency: false,
    idempotencyStrategy: "derived",
    compositeChildren: ["cash-movement.create"],
  },
} as const satisfies Record<string, MutationContractEntry>;
