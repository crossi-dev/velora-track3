// src/lib/mcp/_lib/payments-backend-wizard.port.ts — I/O types for resolveWizardPrefill.
//
// Extracted from payments-backend.port.ts to stay under the 300-line file-size limit.
// Re-exported by payments-backend.port.ts so all callers continue to import from one place.
//
// These types belong to the open_payment_link_wizard render-tool seam:
//   handler (payment-link-mutations.ts) → port (payments-backend.port.ts) →
//   adapter (velora-wizard-prefill.ts)

/**
 * One resolved line item for the payment-link wizard prefill.
 * name and unitPrice are server-resolved — never model-supplied.
 */
export interface WizardPrefillItem {
  productId: string;
  quantity: number;
  name: string;
  unitPrice: number;
  unitPriceOverride?: number;
}

/**
 * Fully resolved prefill shape for the open_payment_link_wizard render tool.
 * The adapter performs all catalog + customer lookups tenant-scoped internally.
 */
export interface WizardPrefill {
  description: string;
  customerId: string;
  customerName: string;
  items: WizardPrefillItem[];
  totalARS: number;
}

export interface ResolveWizardPrefillInput {
  tenantId: string;
  description: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number; unitPriceOverride?: number }>;
}

/**
 * Domain result for resolveWizardPrefill.
 * Success: domainError absent, prefill set.
 * Error: domainError set with an appropriate code.
 */
export type ResolveWizardPrefillResult =
  | { domainError?: undefined; prefill: WizardPrefill }
  | { domainError: "customer_not_found" | "product_not_found"; errorMessage: string };
