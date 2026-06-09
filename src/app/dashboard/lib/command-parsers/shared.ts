import { matchProductByName } from "../../../api/business-assistant/_lib/match-product-by-name";

// ── Public catalog types ──────────────────────────────────────────────

export interface ProductCatalogItem {
  id: string;
  name: string;
  sku?: string | null;
  price?: number | string | null;
}

export interface CustomerCatalogItem {
  id: string;
  name: string;
}

// ── Intent data shapes (exported for type discrimination) ─────────────

export interface SaleLineItem {
  productName: string;
  productId: string | null;
  quantity: number;
  unitPrice: number | null;
}

export interface RegisterSaleData {
  items: SaleLineItem[];
  customerName: string | null;
  customerId: string | null;
  ambiguousCustomer: boolean;
  /**
   * True when the original text contained a send-by-WhatsApp keyword
   * ("mandale", "enviale", "wa", etc.). Caller should dispatch the
   * confirm-and-send-whatsapp flow instead of opening a draft.
   * Detected at parse time so consumers don't need to re-scan the raw
   * text themselves.
   */
  autoSendWhatsapp: boolean;
}

export interface CheckStockData {
  productName: string;
  productId: string | null;
}

export interface StockLoadLineItem {
  productName: string;
  productId: string | null;
  quantity: number;
  unitPrice: number | null;
}

export interface StockLoadData {
  items: StockLoadLineItem[];
}

export interface EditProductData {
  productName: string;
  productId: string | null;
  newPrice: number;
}

export type CashBalanceData = Record<string, never>;

export type InventoryListData = Record<string, never>;

export interface FindCustomerData {
  query: string;
}

export type LowStockQueryData = Record<string, never>;

export interface ProductPriceQueryData {
  productName: string;
  productId: string | null;
}

export type PriceIntentFallbackData = Record<string, never>;

// "withdrawal" = sangría / retiro de efectivo de caja. Added 2026-06-03.
// Previously "retiro" mapped to "adjustment", corrupting caja reports.
export type MovementType = "purchase" | "tax" | "salary" | "adjustment" | "income" | "withdrawal";

export interface RegisterMovementData {
  movementType: MovementType;
  amount: number;
  description: string;
}

export interface CreateProductFromVoiceData {
  productName: string;
  price: number;
  retrySaleText: string;
}

export type InvoiceStatusKey = "issued" | "sent" | "paid";

export interface UpdateInvoiceStatusData {
  invoiceNumberQuery: string;
  status: InvoiceStatusKey;
}

export interface CreateProductData {
  name: string;
  price: number;
  stock: number | null;
}

export type BusinessProfileField = "name" | "phone" | "address" | "email" | "taxId";

export interface UpdateBusinessProfileData {
  field: BusinessProfileField;
  value: string;
}

export interface CreateBudgetLineItem {
  productName: string;
  productId: string | null;
  quantity: number;
  unitPrice: number | null;
}

export interface CreateBudgetData {
  customerName: string;
  items: CreateBudgetLineItem[];
  autoSendWhatsapp: boolean;
}

export type ContactKind = "customer" | "supplier";

export interface AddContactData {
  kind: ContactKind;
  name: string;
  phone: string | null;
  email: string | null;
  taxId: string | null;
  contactName: string | null;
}

export type SalesSummaryPeriod =
  | "today"
  | "yesterday"
  | "week"
  | "month"
  | "day_before_yesterday"
  | "this_week"
  | "this_month"
  | "last_week"
  | "last_month"
  | "named_day"
  | "specific_date";

export interface SalesSummaryData {
  period: SalesSummaryPeriod;
  /**
   * Set when `period` is one of the custom labels produced by `parseRelativeDateAR`
   * (i.e. not the 4 legacy bucket keys). Callers that only support the legacy
   * buckets can ignore this field; callers that query the DB directly MUST
   * use these boundaries instead of `buildPeriodWindow`.
   */
  customRange?: { startMs: number; endMs: number };
}

export type StockAdjustmentMode = "decrease" | "increase" | "set";

export interface StockAdjustmentData {
  mode: StockAdjustmentMode;
  quantity: number;
  productName: string;
  productId: string | null;
  reason: "breakage" | "loss" | "correction" | null;
}

export type BulkPriceMode = "percentage" | "absolute";
// "set" overwrites prices to the absolute amount (e.g. "pone todos a $50").
// Only valid with mode === "absolute" — validator rejects set + percentage.
export type BulkPriceDirection = "up" | "down" | "set";

export interface BulkPriceUpdateData {
  mode: BulkPriceMode;
  direction: BulkPriceDirection;
  amount: number;
}

export type VeloraSingleCommand =
  | { matched: true; intent: "register_sale"; data: RegisterSaleData }
  | { matched: true; intent: "check_stock"; data: CheckStockData }
  | { matched: true; intent: "stock_load"; data: StockLoadData }
  | { matched: true; intent: "edit_product"; data: EditProductData }
  | { matched: true; intent: "cash_balance"; data: CashBalanceData }
  | { matched: true; intent: "sales_summary"; data: SalesSummaryData }
  | { matched: true; intent: "stock_adjustment"; data: StockAdjustmentData }
  | { matched: true; intent: "bulk_price_update"; data: BulkPriceUpdateData }
  | { matched: true; intent: "inventory_list"; data: InventoryListData }
  | { matched: true; intent: "find_customer"; data: FindCustomerData }
  | { matched: true; intent: "low_stock_query"; data: LowStockQueryData }
  | { matched: true; intent: "product_price_query"; data: ProductPriceQueryData }
  | { matched: true; intent: "price_intent_fallback"; data: PriceIntentFallbackData }
  | { matched: true; intent: "register_movement"; data: RegisterMovementData }
  | { matched: true; intent: "create_product_from_voice"; data: CreateProductFromVoiceData }
  | { matched: true; intent: "update_invoice_status"; data: UpdateInvoiceStatusData }
  | { matched: true; intent: "create_product"; data: CreateProductData }
  | { matched: true; intent: "update_business_profile"; data: UpdateBusinessProfileData }
  | { matched: true; intent: "create_budget"; data: CreateBudgetData }
  | { matched: true; intent: "add_contact"; data: AddContactData };

// VeloraCommand is the public return type. Compound-command results carry
// multiple sub-commands, dispatched in order by the consumer.
export type VeloraCommand =
  | VeloraSingleCommand
  | { matched: true; compound: true; commands: VeloraSingleCommand[] }
  | { matched: false };

// ── Shared helpers ────────────────────────────────────────────────────

export const NUMBER_WORDS: Record<string, number> = {
  uno: 1, una: 1, un: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

export const PRODUCT_PREAMBLE_RE =
  /^(?:kilos?|kgs?|kilogramos?|unidades?|bolsas?|cajas?|paquetes?|litros?|lts?)\s+de\s+/;

export const LEADING_DE_RE = /^de\s+/;

// Strips "stock de" / "inventario de" / "cantidad de" when the user asks
// things like "cuánto stock de yerba hay" — the captured product name
// ends up as "stock de yerba" and needs cleaning to just "yerba".
export const STOCK_PREAMBLE_RE = /^(?:stock|inventario|cantidad)\s+de\s+/;

// Strips "precio de" / "precio del" as a prefix when an upstream capture
// leaked it into the product fragment (e.g., pattern 3 of edit-product
// fell back to matching "cambiá X a Y" on "cambiá el precio de yerba a Y"
// when the more specific pattern 1 missed an edge case). Defense-in-depth
// so the fuzzy catalog matcher receives a clean product name regardless.
export const PRICE_PREAMBLE_RE = /^precio\s+(?:de|del)\s+(?:la\s+|las\s+|el\s+|los\s+)?/;

export function resolveProductName(
  productName: string,
  products: ProductCatalogItem[]
): ProductCatalogItem | null {
  if (!productName) return null;
  let match = matchProductByName(productName, products);
  if (!match && productName.endsWith("es") && productName.length > 4) {
    match = matchProductByName(productName.slice(0, -2), products);
  }
  if (!match && productName.endsWith("s") && productName.length > 3) {
    match = matchProductByName(productName.slice(0, -1), products);
  }
  return match;
}

// Matches a trailing price clause that the customer-side regex would
// otherwise capture as a customer name. Same alternatives as
// PRICE_TAIL_RE below, anchored to the full candidate string. Examples
// that match (and must NOT be tagged as a customer):
//   "200", "$200", "200 pesos", "1500 cada una", "$1500 cada un"
// Comma-as-decimal supported (Argentine prices use it). Real customer
// names like "Juan", "Juan 200", "200 Reggae Bar" do not match.
const PRICE_CLAUSE_RE = /^\$?\s*\d+(?:[.,]\d+)?\s*(?:pesos?)?\s*(?:cada\s+una?)?\s*$/i;

// Imperative verbs that signal a SECOND action embedded after the customer
// name (e.g. "vendí 3 a Carlos mándale whatsapp"). Without trimming these,
// the imperative + its payload get absorbed into the customer-name slot,
// the customer match fails, and the second action is silently dropped.
// Exported so the residual-action detector can flag the tail to the user.
// Trailing boundary uses a negative lookahead instead of \b because JS
// regex \b is ASCII-only — it doesn't match between accented letters
// (á, é, etc.) and non-letters, so verbs ending in -á (contactá, avisá)
// would slip past a trailing \b.
export const IMPERATIVE_TAIL_VERBS_RE =
  /\b(?:m[aá]nd[aá]le?|envi[aá](?:le|lo|me)?|contact[aá](?:le|lo)?|llam[aá](?:le|lo)?|decile|escribile|avis[aá](?:le|lo)?)(?![a-záéíóúñ])/i;

export function splitProductAndCustomer(remainder: string): {
  productName: string;
  customerName: string | null;
} {
  const match = remainder.match(/^(.+?)\s+(?:a|al|para)\s+(.+)$/);
  if (match) {
    const candidate = match[2].trim();
    // Reject pure price-clause candidates so they flow back through to
    // parseItemSegment, which has its own PRICE_TAIL_RE that extracts
    // the trailing "a <number>" as the per-unit price. Without this
    // guard, "vendí 50 papas a 200" would create a customer named "200"
    // and silently fall back to catalog price.
    if (PRICE_CLAUSE_RE.test(candidate)) {
      return { productName: remainder.trim(), customerName: null };
    }
    // If the candidate contains an imperative verb (e.g. "carlos mándale
    // whatsapp"), keep only the part before the verb as the customer
    // name. The tail stays in the original input and gets surfaced by
    // the residual-action detector.
    const impMatch = candidate.match(IMPERATIVE_TAIL_VERBS_RE);
    if (impMatch && impMatch.index !== undefined) {
      const before = candidate.slice(0, impMatch.index).trim();
      if (before) {
        return { productName: match[1].trim(), customerName: before };
      }
      return { productName: remainder.trim(), customerName: null };
    }
    return { productName: match[1].trim(), customerName: candidate };
  }
  return { productName: remainder.trim(), customerName: null };
}

export function extractQuantity(remainder: string): { quantity: number; rest: string } {
  const digitMatch = remainder.match(/^(\d+)\s+/);
  if (digitMatch) {
    return { quantity: Number.parseInt(digitMatch[1], 10), rest: remainder.slice(digitMatch[0].length) };
  }
  const wordMatch = remainder.match(/^(uno|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+/);
  if (wordMatch) {
    return { quantity: NUMBER_WORDS[wordMatch[1]] ?? 1, rest: remainder.slice(wordMatch[0].length) };
  }
  return { quantity: 1, rest: remainder };
}

export function cleanProductName(raw: string): string {
  return raw
    .replace(PRICE_PREAMBLE_RE, "")
    .replace(STOCK_PREAMBLE_RE, "")
    .replace(PRODUCT_PREAMBLE_RE, "")
    .replace(LEADING_DE_RE, "")
    .trim();
}

// Splits a body (already stripped of verb and any trailing "a <customer>"
// clause) into per-item segments. Handles commas, semicolons, and the
// conjunction " y " — including the Spanish list form "a, b y c".
export function splitItemSegments(body: string): string[] {
  if (!body) return [];
  const normalized = body.replace(/\s+y\s+/g, ",").replace(/;/g, ",");
  return normalized
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export interface ParsedLineItem {
  productName: string;
  quantity: number;
  unitPrice: number | null;
}

const PRICE_TAIL_RE = /\s+a\s+\$?\s*(\d+(?:[.,]\d+)?)\s*(?:pesos?)?\s*(?:cada\s+una?)?\s*$/;

// Parses a single segment like "50 yerbas", "3 azúcares a $10", "yerba"
// into { productName, quantity, unitPrice }. Missing quantity defaults to
// 1. Missing price returns unitPrice: null so the caller falls back to
// the catalog price.
export function parseItemSegment(segment: string): ParsedLineItem | null {
  let text = segment.trim();
  if (!text) return null;

  let unitPrice: number | null = null;
  const priceMatch = text.match(PRICE_TAIL_RE);
  if (priceMatch) {
    const parsed = Number.parseFloat(priceMatch[1].replace(",", "."));
    if (Number.isFinite(parsed) && parsed > 0) unitPrice = parsed;
    text = text.slice(0, priceMatch.index).trim();
  }

  const { quantity, rest } = extractQuantity(text);
  const productName = cleanProductName(rest || text);
  if (!productName) return null;
  return { productName, quantity: quantity > 0 ? quantity : 1, unitPrice };
}

// Convenience: split body into segments and parse each. Returns an empty
// array when nothing parses cleanly — callers decide what to do.
export function parseItemList(body: string): ParsedLineItem[] {
  return splitItemSegments(body)
    .map(parseItemSegment)
    .filter((item): item is ParsedLineItem => item !== null);
}
