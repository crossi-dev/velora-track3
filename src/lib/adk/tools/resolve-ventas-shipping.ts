// Deterministic shipping pre-resolver for the call_ventas_agent tool.
//
// When the Supervisor detects a payment-link request WITH shipping ("con envío",
// "con despacho", etc.), this module resolves ALL data the Payments Agent needs
// BEFORE the message reaches it — so the LLM never has a data gap to justify
// asking a clarifying question.
//
// What gets resolved here (upstream of the LLM):
//   1. Customer.postalCode (CP destino) — looked up by name from the DB.
//   2. Shipping quote (costARS) — via Logística agent (same path as Unit 2).
//   3. Total = base product amount + shipping cost.
//
// The result is injected as a directive annotation in the message. The format is
// intentionally imperative and complete — no parameter is left ambiguous so the
// Payments Agent LLM cannot find a reason to ask a question.
//
// Degradation contract: any step failing (no customer found, no CP, quote error)
// returns a fallback annotation that still disables the "ask for postal code"
// behaviour by embedding whatever partial data was resolved. The LLM will use
// whatever is in the annotation and let the tool surface a structured error if
// truly missing.

import { resolveShippingQuote } from "@/lib/shipping-quote";
import { cloudLog } from "@/lib/cloud-logger";
import { extractBreakdown, type PaymentLinkBreakdown } from "./resolve-ventas-breakdown";
import { injectResolvedAmount, resolveProductFromMessage, type CatalogProduct } from "./resolve-ventas-amount";
import {
  SHIPPING_RE,
  extractCustomerNameFromMessage,
  lookupCustomerSnapshot,
  persistExtractedFields,
} from "./resolve-ventas-shipping-helpers";
import { extractShippingEntities } from "./extract-shipping-entities";

export interface CustomerSnapshot {
  id: string | null;
  name: string;
  phone: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}

export interface ShippingResolutionResult {
  /** Annotated message to send to the Payments Agent. */
  message: string;
  /** True when the full resolution succeeded (CP + quote resolved). */
  fullyResolved: boolean;
  /**
   * Customer snapshot resolved during shipping lookup.
   * Present when a customer name was found in the message AND the customer
   * was looked up in the DB (even if the shipping quote itself failed).
   * null when no customer name was extracted from the message.
   */
  customerSnapshot: CustomerSnapshot | null;
  /**
   * Structured cost breakdown for the payment link answer card.
   * Present when at least one catalog product was resolved from the message.
   * null when product matching failed or catalog is empty.
   */
  breakdown: PaymentLinkBreakdown | null;
  /**
   * True when the shipping quote failed specifically because the destination
   * postal code is missing from both the DB and the NER extraction.
   * The caller should return a JIT question to the owner for the CP, then retry.
   */
  needsDestinationCP: boolean;
  /**
   * Customer name (best-effort) when needsDestinationCP is true.
   * Used to personalise the JIT question ("¿Cuál es el CP de Juan?").
   */
  cpCustomerName: string | null;
}

/**
 * Pre-resolves ALL shipping-related data before the message reaches the
 * Payments Agent LLM, eliminating every data gap that could trigger a question.
 *
 * When resolution succeeds:
 *   Injects: "(PAGO_CON_ENVÍO_RESUELTO: base=$N + flete=$F = total=$T ARS |
 *              customerName=X destinationPostalCode=YYYY |
 *              llamá create_payment_link con amountARS=T shippingRequired:true
 *              destinationPostalCode=YYYY customerName=X — TODOS los datos están
 *              resueltos, NO preguntes nada)"
 *
 * When customer CP is not found (fallback):
 *   Falls back to injectResolvedAmount output — product amount injected,
 *   shipping flagged but not pre-quoted. The Payments Agent tool will surface
 *   a structured error instead of asking the owner.
 *
 * Only activates for messages that contain a shipping intent keyword.
 * All other messages are returned unchanged via injectResolvedAmount.
 */
export async function resolveVentasShipping(
  message: string,
  businessId: string,
  products: ReadonlyArray<CatalogProduct>,
): Promise<ShippingResolutionResult> {
  // Fast-path: no shipping keywords → delegate to synchronous amount injector.
  if (!SHIPPING_RE.test(message)) {
    return {
      message: injectResolvedAmount(message, products),
      fullyResolved: false,
      customerSnapshot: null,
      breakdown: extractBreakdown(message, products),
      needsDestinationCP: false,
      cpCustomerName: null,
    };
  }

  // Extract product base amount first — needed regardless of shipping outcome.
  const baseAnnotated = injectResolvedAmount(message, products);
  // Parse the injected BASE_PRODUCTS_ARS value from the annotation, if present.
  const baseAmountMatch = baseAnnotated.match(/BASE_PRODUCTS_ARS:\s*\$?([\d.,]+)/);
  const baseAmountRaw = baseAmountMatch?.[1]?.replace(/\./g, "").replace(",", ".") ?? null;
  const baseAmount = baseAmountRaw ? parseFloat(baseAmountRaw) : null;

  // Step 1: Regex name extraction (fast, synchronous — existing path unchanged).
  const regexCustomerName = extractCustomerNameFromMessage(message);

  // Step 2: Gemini NER extraction (best-effort, async).
  // Extracts customerName, address, postalCode, city from the free-text message.
  // Returns null on any error — falls back to regex-only path seamlessly.
  // Source: https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output
  const nerEntities = await extractShippingEntities(message).catch(() => null);

  // Prefer NER name (more accurate for complex messages); fall back to regex.
  const customerName = nerEntities?.customerName ?? regexCustomerName;

  if (!customerName) {
    // No customer name found by either path → can't resolve CP.
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "VENTAS_SHIPPING_NO_CUSTOMER_NAME",
      a2a_transfer: false,
      message: "resolveVentasShipping: no customer name found in message — using base annotation only",
      data: { businessId },
    });
    return {
      message: baseAnnotated,
      fullyResolved: false,
      customerSnapshot: null,
      breakdown: extractBreakdown(message, products),
      needsDestinationCP: false,
      cpCustomerName: null,
    };
  }

  // Step 3: DB customer lookup (existing f_unaccent + pg_trgm path).
  // Sources: https://www.postgresql.org/docs/current/unaccent.html
  //          https://www.postgresql.org/docs/current/pgtrgm.html
  // Run lookup before the quote so we can enrich the row AND pass inline CP.
  const dbSnapshot = await lookupCustomerSnapshot(businessId, customerName).catch(() => null);

  // Step 4: Fill-nulls-only persistence.
  // Write NER-extracted fields to the Customer row when the current DB value is null.
  // Never overwrites existing data — progressive enrichment, collect once, reuse forever.
  // Reference: https://docs.stripe.com/connect/required-verification-information
  //   (currently_due incremental verification model)
  if (dbSnapshot?.id && nerEntities) {
    await persistExtractedFields(dbSnapshot.id, dbSnapshot, nerEntities, businessId).catch(() => {});
  }

  // Step 5: Resolve shipping quote.
  // Pass inline CP from NER as fallback when Customer.postalCode is null in the DB.
  // resolveShippingQuote already prefers Customer.postalCode (SSOT) over inlinePostalCode.
  let quoteResult;
  try {
    quoteResult = await resolveShippingQuote({
      businessId,
      customerName,
      inlinePostalCode: nerEntities?.postalCode ?? null,
      inlineAddress:    nerEntities?.address    ?? null,
    });
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "VENTAS_SHIPPING_QUOTE_ERROR",
      a2a_transfer: false,
      message: "resolveVentasShipping: shipping quote threw — falling back to base annotation",
      data: { businessId, error: err instanceof Error ? err.message : String(err) },
    });
    return {
      message: baseAnnotated,
      fullyResolved: false,
      customerSnapshot: dbSnapshot,
      breakdown: extractBreakdown(message, products),
      needsDestinationCP: false,
      cpCustomerName: null,
    };
  }

  if (!quoteResult.ok) {
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "VENTAS_SHIPPING_QUOTE_FAILED",
      a2a_transfer: false,
      message: `resolveVentasShipping: quote failed (${quoteResult.reason}) — falling back to base annotation`,
      data: { businessId, reason: quoteResult.reason },
    });
    // Signal needsDestinationCP when the only blocker is the missing destination CP.
    // The caller (execute-payment-link-fast-path) will surface a JIT question.
    const needsCP = quoteResult.reason === "missing_destination_postal_code";
    return {
      message: baseAnnotated,
      fullyResolved: false,
      customerSnapshot: dbSnapshot,
      breakdown: extractBreakdown(message, products),
      needsDestinationCP: needsCP,
      cpCustomerName: needsCP ? customerName : null,
    };
  }

  const { costARS, addressSnapshot, resolvedCustomerId } = quoteResult;
  const destPostalCode = addressSnapshot.postalCode;

  // Build customerSnapshot from the resolved addressSnapshot + resolvedCustomerId.
  const resolvedCustomerSnapshot: CustomerSnapshot = {
    id: resolvedCustomerId,
    name: addressSnapshot.name,
    phone: addressSnapshot.phone || null,
    address: addressSnapshot.street || null,
    postalCode: addressSnapshot.postalCode || null,
    city: addressSnapshot.city || null,
  };

  // If we have a base amount, compute the full total here.
  const totalARS = baseAmount !== null ? baseAmount + costARS : null;
  // Build the fully-resolved directive annotation.
  // Every parameter create_payment_link accepts is pre-filled so the LLM has
  // zero ambiguity and cannot justify asking a question.
  const totalDisplay = totalARS !== null
    ? `$${totalARS.toLocaleString("es-AR")} ARS`
    : `(base + $${costARS.toLocaleString("es-AR")} flete)`;

  // create_payment_link expects amountARS = product base BEFORE shipping — the
  // tool quotes the freight itself and adds it. Pass the base only; passing
  // base+flete here makes the tool count the freight twice.
  const amountParam = baseAmount;

  // 2026-05-27: resolve productId upstream so the Payments Agent LLM never has
  // to infer it. The previous annotation used "items=[mapeá los productos desde
  // el catálogo]" which forced the LLM to do a catalog lookup it cannot do
  // (no catalog tool or context available in the Payments Agent) — it invented
  // a random alphanumeric ID, which hit registerSaleWithPaymentLinkUseCase,
  // failed the DB lookup, and surfaced "No encontré el producto <invented-id>".
  // Fix: resolveProductFromMessage (same extractSaleEntities path already run
  // for the base amount) returns the matched productId; we embed it directly.
  // Fallback: if resolution fails, the LLM placeholder is preserved so existing
  // degradation behaviour (agent asks for clarification) is unchanged.
  const resolvedProduct = resolveProductFromMessage(message, products);
  const itemsAnnotation = resolvedProduct
    ? `[{productId="${resolvedProduct.productId}", quantity=${resolvedProduct.qty}}]`
    : `[mapeá los productos mencionados desde el catálogo a {productId, quantity}]`;

  const annotation = amountParam !== null
    ? `(PAGO_CON_ENVÍO_RESUELTO: base=$${(baseAmount ?? 0).toLocaleString("es-AR")} + flete=$${costARS.toLocaleString("es-AR")} = total ${totalDisplay} | customerId="${resolvedCustomerId}" customerName="${customerName}" destinationPostalCode="${destPostalCode}" — llamá create_payment_link con customerId="${resolvedCustomerId}" items=${itemsAnnotation} shippingRequired=true destinationPostalCode="${destPostalCode}" — TODOS los datos están resueltos, NO preguntes nada al dueño)`
    : `(PAGO_CON_ENVÍO_RESUELTO: flete=$${costARS.toLocaleString("es-AR")} ARS | customerId="${resolvedCustomerId}" customerName="${customerName}" destinationPostalCode="${destPostalCode}" — llamá create_payment_link con customerId="${resolvedCustomerId}" items=${itemsAnnotation} shippingRequired=true destinationPostalCode="${destPostalCode}" — NO preguntes nada al dueño)`;

  // Append annotation to the ORIGINAL message (not the base-annotated one) to
  // avoid stacking two annotations which could confuse the LLM.
  const resolvedMessage = `${message} ${annotation}`;

  cloudLog({
    severity: "INFO",
    component: "Supervisor",
    action: "VENTAS_SHIPPING_FULLY_RESOLVED",
    a2a_transfer: false,
    message: `resolveVentasShipping: full pre-resolution succeeded`,
    data: { businessId, customerName, destPostalCode, costARS, totalARS },
  });

  // Detect courier label from annotation / quoteResult (Andreani is the only supported courier today).
  const shippingCourier = "Andreani";

  return {
    message: resolvedMessage,
    fullyResolved: true,
    customerSnapshot: resolvedCustomerSnapshot,
    breakdown: extractBreakdown(message, products, costARS, shippingCourier),
    needsDestinationCP: false,
    cpCustomerName: null,
  };
}

// Lightweight sync helper — checks if a message contains shipping intent without
// triggering any async work. Used by call-ventas-agent-tool to decide which
// resolution path to take.
export function hasShippingIntent(message: string): boolean {
  return SHIPPING_RE.test(message);
}

// Re-export helpers consumed by downstream modules that previously imported from here.
export { extractCustomerNameFromMessage } from "./resolve-ventas-shipping-helpers";

// Re-export for tests that import from this module.
export type { CatalogProduct };
