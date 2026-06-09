import type { AssistantIntent, AssistantTaskModelResponse } from "./types";
import { normalizeActionText } from "./shared";

interface ConfidenceAssessment {
  intentConfidence: "high" | "medium" | "low";
  entityConfidence: "high" | "medium" | "low";
  needsClarification: boolean;
  reason: string | null;
  modelSelfReported: number | null;
}

// Per-intent confidence thresholds. Destructive/irreversible intents require
// higher model certainty before proceeding to the confirmation gate.
// Falls back to DEFAULT for intents not listed here.
const DEFAULT_CONFIDENCE_THRESHOLD = 0.60;
const INTENT_CONFIDENCE_THRESHOLDS: Partial<Record<AssistantIntent, number>> = {
  delete_product:    0.85, // irreversible — extra caution
  bulk_price_update: 0.80, // affects entire catalog
  register_movement: 0.80, // financial record
  return_sale:       0.80, // reversal, irreversible
  adjust_stock:      0.75, // inventory mutation
};

function getConfidenceThreshold(intent: AssistantIntent): number {
  return INTENT_CONFIDENCE_THRESHOLDS[intent] ?? DEFAULT_CONFIDENCE_THRESHOLD;
}

type CatalogEntry = { id: string; name: string };

/**
 * Lightweight confidence gate. No AI calls — just field-presence checks and
 * entity-existence verification against the in-memory catalogs.
 *
 * intentConfidence:
 *   high   — intent matches safeIntent and all required payload fields are present
 *   medium — intent matches but entity references are ambiguous or partial
 *   low    — payload is sparse, contradictory, or entity IDs are unverifiable
 *
 * entityConfidence follows the same scale, driven by whether matched IDs
 * actually exist in the provided catalog lists.
 *
 * needsClarification is true only when intentConfidence === "low".
 */
export function assessActionConfidence(
  safeIntent: AssistantIntent,
  parsed: AssistantTaskModelResponse,
  products: CatalogEntry[],
  customers: CatalogEntry[],
  suppliers: CatalogEntry[]
): ConfidenceAssessment {
  // --- entity existence checks ---
  const matchedProductId = normalizeActionText(parsed.matchedProductId);
  const matchedCustomerId = normalizeActionText(parsed.matchedCustomerId);
  const matchedSupplierId = normalizeActionText(parsed.matchedSupplierId);

  const productExists =
    !matchedProductId || products.some((p) => p.id === matchedProductId);
  const customerExists =
    !matchedCustomerId || customers.some((c) => c.id === matchedCustomerId);
  const supplierExists =
    !matchedSupplierId || suppliers.some((s) => s.id === matchedSupplierId);

  const allEntitiesExist = productExists && customerExists && supplierExists;

  // Build a short reason string for missing entities (used in trace + clarification)
  const missingEntities: string[] = [];
  if (!productExists) missingEntities.push(`producto "${matchedProductId}"`);
  if (!customerExists) missingEntities.push(`cliente "${matchedCustomerId}"`);
  if (!supplierExists) missingEntities.push(`proveedor "${matchedSupplierId}"`);

  // --- intent-specific required-field checks ---
  let intentConfidence: "high" | "medium" | "low" = "high";
  let intentReason: string | null = null;

  switch (safeIntent) {
    case "register_sale": {
      // Acceptable even without a matched product — frontend handles the draft
      const hasProduct = matchedProductId || normalizeActionText(parsed.product?.name);
      if (!hasProduct) {
        intentConfidence = "medium";
        intentReason = "sin producto identificado";
      }
      break;
    }

    case "adjust_stock": {
      const hasProduct = matchedProductId || normalizeActionText(parsed.product?.name);
      const hasQty = parsed.stockAdjustment?.quantity != null;
      const hasMode = normalizeActionText(parsed.stockAdjustment?.mode);
      if (!hasProduct || !hasQty || !hasMode) {
        intentConfidence = !hasProduct ? "low" : "medium";
        intentReason = "faltan datos del ajuste de stock";
      }
      break;
    }

    case "edit_product": {
      const hasProduct = matchedProductId || normalizeActionText(parsed.product?.name);
      const hasEdit =
        normalizeActionText(parsed.productEdit?.field) ||
        (Array.isArray(parsed.productEdits) && parsed.productEdits.length > 0);
      if (!hasProduct && !hasEdit) {
        intentConfidence = "low";
        intentReason = "sin producto ni campo a editar";
      } else if (!hasProduct || !hasEdit) {
        intentConfidence = "medium";
        intentReason = "datos de edición incompletos";
      }
      break;
    }

    case "stock_load": {
      const hasSingle = parsed.stockDraft?.itemName || parsed.stockDraft?.quantity;
      const hasMulti = Array.isArray(parsed.stockDrafts) && parsed.stockDrafts.length > 0;
      if (!hasSingle && !hasMulti) {
        intentConfidence = "low";
        intentReason = "sin datos de carga de stock";
      }
      break;
    }

    case "edit_customer":
    case "edit_supplier": {
      const hasEntity =
        matchedCustomerId || matchedSupplierId ||
        normalizeActionText(parsed.customer?.name) ||
        normalizeActionText(parsed.supplier?.name);
      if (!hasEntity) {
        intentConfidence = "medium";
        intentReason = "entidad no identificada";
      }
      break;
    }

    // Intents with their own granular validation — always pass here
    case "register_movement":
    case "create_customer":
    case "create_supplier":
    case "bulk_price_update":
    case "business_query":
    case "report_event":
    case "create_purchase_request":
    case "answer":
    default:
      break;
  }

  // --- entity confidence ---
  const entityConfidence: "high" | "medium" | "low" = allEntitiesExist
    ? "high"
    : missingEntities.length === 1
      ? "medium"
      : "low";

  // --- ghost entity guard: entity IDs that don't exist → escalate to low ---
  if (!allEntitiesExist && intentConfidence !== "low") {
    intentConfidence = "medium";
    if (!intentReason) {
      intentReason = `ID no encontrado en catálogo: ${missingEntities.join(", ")}`;
    }
  }

  // Model self-reported confidence: if the LLM admits low confidence below the
  // threshold for a destructive-leaning intent, escalate to clarification even
  // when post-hoc heuristics passed. Trivial intents skip this gate to avoid
  // false positives on "hola" / "gracias" style messages.
  const rawSelf = parsed.confidence;
  const modelSelfReported =
    typeof rawSelf === "number" && Number.isFinite(rawSelf)
      ? Math.max(0, Math.min(1, rawSelf))
      : null;
  const isTrivialIntent = safeIntent === "answer";
  const threshold = getConfidenceThreshold(safeIntent);
  let selfReportedTriggeredLow = false;
  if (
    !isTrivialIntent &&
    modelSelfReported !== null &&
    modelSelfReported < threshold
  ) {
    selfReportedTriggeredLow = true;
    intentConfidence = "low";
    if (!intentReason) {
      intentReason = `el modelo reportó confidence ${modelSelfReported.toFixed(2)} (umbral ${threshold})`;
    }
  }

  const needsClarification = intentConfidence === "low" || selfReportedTriggeredLow;
  const reason = intentReason ?? (missingEntities.length > 0 ? `ID no encontrado: ${missingEntities.join(", ")}` : null);

  return { intentConfidence, entityConfidence, needsClarification, reason, modelSelfReported };
}
