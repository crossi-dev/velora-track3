import {
  clearPendingUnknownProduct,
  getPendingUnknownProduct,
  parsePriceResponse,
} from "../unknown-product-flow";
import type { VeloraSingleCommand } from "./shared";

// Fires when the voice-trained catalog flow has a pending
// unknown-product question and the user's next input parses as a bare
// price ("2500", "$2500", "2500 pesos"). Emits create_product_from_voice
// with the resolved name (from pending state), price (from the input),
// and retrySaleText (so the sale can re-dispatch after product is
// created).
//
// Returns null when:
//   - No pending state → other detectors run normally.
//   - Pending state exists but input doesn't parse as a price → caller
//     falls through to AI (which can continue the conversation).

export function detectUnknownProductPriceResponse(
  normalized: string,
): VeloraSingleCommand | null {
  const pending = getPendingUnknownProduct();
  if (!pending) return null;

  const price = parsePriceResponse(normalized);
  if (price === null) return null;

  // Consume the pending state — the confirmation card will carry all
  // the info needed; if the user cancels, they can retype the sale.
  clearPendingUnknownProduct();

  return {
    matched: true,
    intent: "create_product_from_voice",
    data: {
      productName: pending.productName,
      price,
      retrySaleText: pending.saleText,
    },
  };
}
