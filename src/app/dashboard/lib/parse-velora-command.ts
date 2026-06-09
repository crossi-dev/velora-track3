// Public entry point for the command layer. Returns the confidence-scored
// `CommandLayerResult` shape with explicit match / ambiguous / compound /
// no-match kinds.
//
// Internally still routes through `parseVeloraCommandLegacy` (the original
// regex-cascade) and the v2 adapter, which extracts confidence signals
// from the raw text + match data. Each detector can later be migrated to
// emit signals directly, retiring the adapter — but the public contract
// stays stable.

import type { CommandLayerResult } from "./command-parsers/types-v2";
import type { CustomerCatalogItem, ProductCatalogItem } from "./command-parsers/shared";
import { parseVeloraCommandLegacy } from "./velora-command-parser";
import { adaptLegacyCommand } from "./command-parsers/v2-adapter";

export function parseVeloraCommand(
  text: string,
  products: ProductCatalogItem[],
  customers: CustomerCatalogItem[],
): CommandLayerResult {
  if (typeof text !== "string" || !text.trim()) {
    return { kind: "no-match", reason: "empty-input" };
  }
  const legacy = parseVeloraCommandLegacy(text, products, customers);
  return adaptLegacyCommand(text, legacy);
}
