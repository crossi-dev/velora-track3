// New command-layer contract — confidence-scored, with explicit ambiguity.
// Coexists with the legacy `VeloraCommand` union during the migration so
// detectors can be migrated one at a time. Once all detectors emit the new
// shape and the only caller (useAssistantChat.handleGo) reads it, the old
// union and its consumers are deleted.
//
// See plan: command-layer + chat state machine refactor.

import type {
  AddContactData,
  BulkPriceUpdateData,
  CashBalanceData,
  CheckStockData,
  CreateBudgetData,
  CreateProductData,
  CreateProductFromVoiceData,
  EditProductData,
  FindCustomerData,
  InventoryListData,
  LowStockQueryData,
  PriceIntentFallbackData,
  ProductPriceQueryData,
  RegisterMovementData,
  RegisterSaleData,
  SalesSummaryData,
  StockAdjustmentData,
  StockLoadData,
  UpdateBusinessProfileData,
  UpdateInvoiceStatusData,
} from "./shared";
import type { AssistantIntent } from "@/app/api/business-assistant/_lib/types";

// ─── Confidence signals ─────────────────────────────────────────────
// Tags that detectors emit to explain WHY they assigned a confidence
// score. Used both for the threshold heuristics and for surfacing in
// logs when a low-confidence match is overridden by AI.

export type ConfidenceSignal =
  | "exact-verb-match"        // input contains a strict canonical verb (vendí, cargá, etc.)
  | "fuzzy-verb-match"        // verb matched but with typo/inflection
  | "product-resolved"         // product name resolved to a catalog ID
  | "product-fuzzy"            // product matched approximately
  | "customer-resolved"        // customer name resolved to a catalog ID
  | "customer-fuzzy"           // customer matched approximately
  | "numeric-payload-present"  // input has the numbers the intent expects
  | "single-clean-segment"     // no compound separators, no imperatives mid-text
  | "imperative-tail"          // imperative verb after the main intent (lowers confidence)
  | "stt-artifact"             // collapse-split-keywords had to glue tokens
  | "ambiguous-target";        // intent clear but the target (product/customer) is not

// ─── Per-intent data union ──────────────────────────────────────────
// Keeps the same payload shapes as `VeloraSingleCommand` but separated
// out so the new result type can compose them without dragging the
// legacy `matched: true` flag.

export type CommandIntentPayload =
  | { intent: "register_sale"; data: RegisterSaleData }
  | { intent: "check_stock"; data: CheckStockData }
  | { intent: "stock_load"; data: StockLoadData }
  | { intent: "edit_product"; data: EditProductData }
  | { intent: "cash_balance"; data: CashBalanceData }
  | { intent: "sales_summary"; data: SalesSummaryData }
  | { intent: "stock_adjustment"; data: StockAdjustmentData }
  | { intent: "bulk_price_update"; data: BulkPriceUpdateData }
  | { intent: "inventory_list"; data: InventoryListData }
  | { intent: "find_customer"; data: FindCustomerData }
  | { intent: "low_stock_query"; data: LowStockQueryData }
  | { intent: "product_price_query"; data: ProductPriceQueryData }
  | { intent: "price_intent_fallback"; data: PriceIntentFallbackData }
  | { intent: "register_movement"; data: RegisterMovementData }
  | { intent: "create_product_from_voice"; data: CreateProductFromVoiceData }
  | { intent: "update_invoice_status"; data: UpdateInvoiceStatusData }
  | { intent: "create_product"; data: CreateProductData }
  | { intent: "update_business_profile"; data: UpdateBusinessProfileData }
  | { intent: "create_budget"; data: CreateBudgetData }
  | { intent: "add_contact"; data: AddContactData };

// ─── Result variants ────────────────────────────────────────────────

// Confidence ≥ HIGH: command layer dispatches directly without consulting AI.
// Confidence in [LOW, HIGH): emitted as "ambiguous" — AI receives bestGuess
//   as context to refine or override.
// Confidence < LOW: emitted as "no-match" — AI free-interprets.
export const CONFIDENCE_HIGH = 0.85;
export const CONFIDENCE_LOW = 0.6;

export type CommandLayerResult =
  | ({
      kind: "match";
      confidence: number;
      signals: ConfidenceSignal[];
    } & CommandIntentPayload)
  | ({
      kind: "ambiguous";
      confidence: number;
      reason: string;
      signals: ConfidenceSignal[];
      bestGuess: CommandIntentPayload;
    })
  | { kind: "compound"; commands: CommandLayerResult[] }
  | { kind: "no-match"; reason?: string };

// ─── Detector-shared confidence helper ──────────────────────────────
// Detectors call this with the signals they observed. Centralised so
// signal weights stay consistent across intents. Per D2 of the plan,
// this is a single helper rather than per-detector custom scoring.

interface ConfidenceWeights {
  base: number;                 // baseline if a detector matched at all
  per: Partial<Record<ConfidenceSignal, number>>;
}

// Default weights tuned against the plan's 10 fixture cases. Tighten
// per-intent later if log data shows a specific intent under-/over-
// scoring systematically.
const DEFAULT_WEIGHTS: ConfidenceWeights = {
  base: 0.5,
  per: {
    "exact-verb-match": 0.25,
    "fuzzy-verb-match": 0.10,
    "product-resolved": 0.15,
    "product-fuzzy": 0.05,
    "customer-resolved": 0.10,
    "customer-fuzzy": 0.03,
    "numeric-payload-present": 0.10,
    "single-clean-segment": 0.05,
    "imperative-tail": -0.20,    // lowers confidence
    "stt-artifact": -0.05,       // mild drag
    "ambiguous-target": -0.20,
  },
};

export function computeConfidence(
  signals: ConfidenceSignal[],
  weights: ConfidenceWeights = DEFAULT_WEIGHTS,
): number {
  let score = weights.base;
  for (const signal of signals) {
    score += weights.per[signal] ?? 0;
  }
  // Clamp to [0, 1].
  return Math.max(0, Math.min(1, score));
}

// ─── Re-export the discriminator type for tests ─────────────────────

export type { AssistantIntent };
