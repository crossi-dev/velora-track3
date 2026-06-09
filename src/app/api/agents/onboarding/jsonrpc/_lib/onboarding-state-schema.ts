import { z } from "zod";

// Zod schema for the `state` object accepted by the A2A OnboardingAgent
// JSON-RPC endpoint. All fields are optional with safe defaults so that
// external callers can omit fields that are not yet known; the agent's own
// state machine handles missing data gracefully.
//
// Mirrors OnboardingState in onboarding-agent.contract.ts — keep in sync.
export const OnboardingStateInputSchema = z.object({
  businessNameSet: z.boolean().optional().default(false),
  paymentMethodsSet: z.boolean().optional().default(false),
  paymentMethodsIncludeTransferencia: z.boolean().optional().default(false),
  transferAlias: z.string().nullable().optional().default(null),
  transferAliasSet: z.boolean().optional().default(false),
  postalCodeSet: z.boolean().optional().default(false),
  courierPreferenceSet: z.boolean().optional().default(false),
  courierPreference: z.string().nullable().optional().default(null),
  whatsappPhoneSet: z.boolean().optional().default(false),
  productCount: z.number().int().min(0).optional().default(0),
  pendingStockProduct: z.object({
    productId: z.string(),
    name: z.string(),
  }).nullable().optional().default(null),
  mercadoPagoSelected: z.boolean().optional().default(false),
  mercadoPagoConnected: z.boolean().optional().default(false),
  mercadoPagoOnboardingDeferred: z.boolean().optional().default(false),
  customerCount: z.number().int().min(0).optional().default(0),
  customersOnboardingSkipped: z.boolean().optional().default(false),
  arcaCertConnected: z.boolean().optional().default(false),
  arcaOnboardingDeferred: z.boolean().optional().default(false),
  courierCredentialsConnected: z.boolean().optional().default(false),
  andreaniOnboardingDeferred: z.boolean().optional().default(false),
  arcaPendingStep: z.string().nullable().optional().default(null),
  andreaniPendingStep: z.string().nullable().optional().default(null),
  // Onboarding redesign 2026-05-25 flags.
  skippedCatalog: z.boolean().optional().default(false),
  firstSalePromptShown: z.boolean().optional().default(false),
});

export type OnboardingStateInput = z.infer<typeof OnboardingStateInputSchema>;
