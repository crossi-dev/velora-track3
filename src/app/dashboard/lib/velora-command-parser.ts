import { normalizeForMatching } from "../../api/business-assistant/_lib/shared";
import { collapseSplitKeywords } from "./collapse-split-keywords";
import { detectBulkPriceUpdate } from "./command-parsers/bulk-price-update";
import { detectAddContact } from "./command-parsers/add-contact";
import { detectCashBalance } from "./command-parsers/cash-balance";
import { detectCheckStock } from "./command-parsers/check-stock";
import { detectCreateBudget } from "./command-parsers/create-budget";
import { detectCreateProduct } from "./command-parsers/create-product";
import { detectFindCustomer } from "./command-parsers/find-customer";
import { detectInventoryList } from "./command-parsers/inventory-list";
import { detectEditProduct } from "./command-parsers/edit-product";
import { detectLowStockQuery } from "./command-parsers/low-stock";
import { detectPriceIntentFallback } from "./command-parsers/price-intent-fallback";
import { detectRegisterMovement } from "./command-parsers/register-movement";

import { detectUnknownProductPriceResponse } from "./command-parsers/unknown-product-price-response";
import { detectUpdateBusinessProfile } from "./command-parsers/update-business-profile";
import { detectUpdateInvoiceStatus } from "./command-parsers/update-invoice-status";
import { detectProductPriceQuery } from "./command-parsers/product-price-query";
import { detectRegisterSale } from "./command-parsers/register-sale";
import { detectSalesSummary } from "./command-parsers/sales-summary";
import { detectStockAdjustment } from "./command-parsers/stock-adjustment";
import { detectStockLoad } from "./command-parsers/stock-load";
import type {
  CustomerCatalogItem,
  ProductCatalogItem,
  VeloraCommand,
  VeloraSingleCommand,
} from "./command-parsers/shared";

// Re-export public types so existing callers importing from this path
// continue to work without touching their imports.
export type {
  BulkPriceDirection,
  BulkPriceMode,
  BulkPriceUpdateData,
  CashBalanceData,
  CheckStockData,
  CustomerCatalogItem,
  EditProductData,
  PriceIntentFallbackData,
  ProductCatalogItem,
  ProductPriceQueryData,
  RegisterSaleData,
  SaleLineItem,
  SalesSummaryData,
  SalesSummaryPeriod,
  StockAdjustmentData,
  StockAdjustmentMode,
  StockLoadData,
  StockLoadLineItem,
  VeloraCommand,
  VeloraSingleCommand,
} from "./command-parsers/shared";

function runDetectors(
  normalized: string,
  products: ProductCatalogItem[],
  customers: CustomerCatalogItem[]
): VeloraSingleCommand | null {
  return (
    // Voice-trained catalog: runs first so a bare price reply to
    // "¿Cuál es el precio?" wins over any other intent.
    detectUnknownProductPriceResponse(normalized) ??
    detectCashBalance(normalized) ??
    detectSalesSummary(normalized) ??
    detectBulkPriceUpdate(normalized) ??
    detectCreateProduct(normalized) ??
    detectUpdateBusinessProfile(normalized) ??
    detectAddContact(normalized) ??
    detectCreateBudget(normalized, products) ??
    detectStockAdjustment(normalized, products) ??
    detectEditProduct(normalized, products) ??
    detectPriceIntentFallback(normalized) ??
    detectStockLoad(normalized, products) ??
    detectUpdateInvoiceStatus(normalized) ??
    detectRegisterMovement(normalized) ??
    detectRegisterSale(normalized, products, customers) ??
    detectInventoryList(normalized) ??
    detectLowStockQuery(normalized) ??
    detectFindCustomer(normalized) ??
    detectProductPriceQuery(normalized, products) ??
    detectCheckStock(normalized, products)
  );
}

// Splits a normalized input on compound separators (period, semicolon,
// "luego"/"despues"/"tambien") then tries to parse each half as a single
// command. If at least two halves resolve to distinct intents, return a
// compound result. Uses these separators because " y " and "," are already
// consumed by multi-item detection inside a single intent.
const COMPOUND_SEPARATOR_RE = /\s*(?:\.|;|\bluego\b|\bdespues\b|\btambien\b|\by\s+(?:despues|tambien)\b)\s*/;

function detectCompound(
  normalized: string,
  products: ProductCatalogItem[],
  customers: CustomerCatalogItem[]
): VeloraCommand | null {
  const segments = normalized.split(COMPOUND_SEPARATOR_RE).map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length < 2) return null;

  const commands: VeloraSingleCommand[] = [];
  for (const segment of segments) {
    const result = runDetectors(segment, products, customers);
    if (result) commands.push(result);
  }
  if (commands.length < 2) return null;
  return { matched: true, compound: true, commands };
}

// Runs intent detectors in priority order. Specific/action intents before
// generic query intents so "vendí X" never matches check_stock and
// "descontá X" never matches sale. Before returning a single command,
// checks if the input is actually a compound (multiple sentence-level
// intents joined by period/semicolon/"luego").
//
// As of the chat-refactor, this is internal to the v2 adapter — external
// callers should import `parseVeloraCommand` from `parse-velora-command.ts`
// (which returns the new confidence-scored shape).
export function parseVeloraCommandLegacy(
  text: string,
  products: ProductCatalogItem[],
  customers: CustomerCatalogItem[]
): VeloraCommand {
  if (typeof text !== "string" || !text.trim()) return { matched: false };
  // STT artifact repair: browser SpeechRecognition can split a word
  // across a mid-word pause ("stoc\nk"). Glue known domain nouns back
  // together before matching patterns that assume whole-word tokens.
  const repaired = collapseSplitKeywords(text);
  const normalized = normalizeForMatching(repaired);

  const compound = detectCompound(normalized, products, customers);
  if (compound) return compound;

  const single = runDetectors(normalized, products, customers);
  if (single) return single;

  return { matched: false };
}
