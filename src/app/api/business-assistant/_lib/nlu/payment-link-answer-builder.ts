// Payment link answer text builder.
//
// Formats the breakdown section shown in the chat card when the owner
// generates a payment link — itemised products, shipping cost, and total.
// Extracted from execute-payment-link-fast-path.ts to keep that file under
// the 300-line area limit.

import type { PaymentLinkBreakdown } from "@/lib/adk/tools/resolve-ventas-breakdown";
import { formatARS } from "@/lib/format/money";

export { formatARS };

/**
 * Builds the breakdown section of the payment link answer.
 * Returns a multi-line string ready to embed in the answer text.
 */
export function buildBreakdownText(breakdown: PaymentLinkBreakdown): string {
  const lines: string[] = [];

  lines.push("Items:");
  for (const item of breakdown.items) {
    lines.push(`• ${item.quantity}× ${item.name} ${formatARS(item.unitPrice)}`);
  }

  if (breakdown.shippingCost !== undefined) {
    const courier = breakdown.shippingCourier ?? "Envío";
    lines.push(`\n${courier}: ${formatARS(breakdown.shippingCost)}`);
  }

  lines.push("─────────────────");
  lines.push(`Total: ${formatARS(breakdown.total)}`);

  return lines.join("\n");
}
