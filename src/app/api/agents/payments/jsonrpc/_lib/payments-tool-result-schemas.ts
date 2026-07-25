// payments-tool-result-schemas.ts — Zod output schemas for Payments Agent tool results.
// ADK 2026 hardening: validate both input AND output for every tool.
// Place here (not colocated) to keep the tool files under the 300-line hard limit.

import { z } from "zod/v3";

// ---------------------------------------------------------------------------
// create_payment_link — success path
// ---------------------------------------------------------------------------

export const CreatePaymentLinkSuccessSchema = z.object({
  sandbox: z.boolean(),
  preferenceId: z.string().nullable(),
  checkoutUrl: z.string().nullable(),
  instructions: z.string().nullable(),
  paymentIntentId: z.string(),
  amountARS: z.number(),
  baseAmountARS: z.number(),
  shippingCostARS: z.number(),
  shippingRequired: z.boolean(),
  description: z.string(),
  customerName: z.string().nullable(),
  status: z.literal("pending"),
  currency: z.literal("ARS"),
});

// Replayed path (idempotency hit — already created this turn)
export const CreatePaymentLinkReplayedSchema = z.object({
  replayed: z.literal(true),
  paymentIntentId: z.string(),
  message: z.string(),
  currency: z.literal("ARS"),
});

// Error path — any error string, always includes currency:"ARS" for LLM consistency
export const CreatePaymentLinkErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  currency: z.literal("ARS"),
});

// Union: one of success | replayed | error
export const CreatePaymentLinkResultSchema = z.union([
  CreatePaymentLinkSuccessSchema,
  CreatePaymentLinkReplayedSchema,
  CreatePaymentLinkErrorSchema,
]);

export type CreatePaymentLinkResult = z.infer<typeof CreatePaymentLinkResultSchema>;

// ---------------------------------------------------------------------------
// get_payment_status — success path
// ---------------------------------------------------------------------------

export const GetPaymentStatusSuccessSchema = z.object({
  sandbox: z.boolean(),
  paymentIntentId: z.string(),
  customerName: z.string().nullable(),
  providerRef: z.string().nullable(),
  // Full Velora canonical status set — aligned with mp-status-mapping.ts.
  // "refunded" covers fully/partially refunded MP payments.
  // "disputed" covers charged_back MP payments.
  status: z.enum(["pending", "approved", "rejected", "refunded", "disputed", "error"]),
  currency: z.literal("ARS"),
});

// Error path
export const GetPaymentStatusErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  paymentIntentId: z.string().optional(),
  detail: z.string().optional(),
  currency: z.literal("ARS"),
});

export const GetPaymentStatusResultSchema = z.union([
  GetPaymentStatusSuccessSchema,
  GetPaymentStatusErrorSchema,
]);

export type GetPaymentStatusResult = z.infer<typeof GetPaymentStatusResultSchema>;
