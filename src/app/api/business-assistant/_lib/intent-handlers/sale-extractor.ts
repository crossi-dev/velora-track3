import { reportWarning } from "@/lib/cloud-logger";
import { matchProductByNameSemantic } from "../match-product-by-name.semantic";
import { findBestCustomerMatch } from "../handlers/customer-matching";
import { findCustomersByDescription } from "@/lib/semantic-recall";
import { getProductCandidates } from "../handlers/product-candidates";
import { validateProductMatch } from "../product-match-validator";

export interface SaleDraftInput {
  customerName?: string | null;
  taxId?: string | null;
  items?: Array<{
    productName?: string | null;
    quantity?: number | string | null;
    unitPrice?: number | string | null;
  }> | null;
}

export interface ResolvedSaleItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number | null;
  subtotal: number | null;
}

export interface ResolvedSaleDraft {
  kind: "resolved";
  customer: { id: string | null; name: string };
  taxId: string | null;
  items: ResolvedSaleItem[];
  skipped: string[];
  total: number;
}

export interface AmbiguousCustomer {
  kind: "ambiguous_customer";
  query: string;
  candidates: Array<{ id: string; name: string }>;
}

export interface EmptyDraft {
  kind: "empty";
  reason: "no_items_resolved" | "no_draft" | "no_quantity";
}

export type ExtractorResult = ResolvedSaleDraft | AmbiguousCustomer | EmptyDraft;

interface CatalogProduct {
  id: string;
  name: string;
  sku: string | null;
  price?: number | string | null;
}

const MAX_CUSTOMER_CANDIDATES = 5;

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const asString = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  const parsed = Number.parseFloat(asString.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function resolvePrice(
  requestedPrice: number | string | null | undefined,
  catalogPrice: number | string | null | undefined
): number | null {
  const req = toNumber(requestedPrice);
  if (req !== null && req > 0) return req;
  const cat = toNumber(catalogPrice);
  if (cat !== null && cat > 0) return cat;
  return null;
}

// Resolves a model-produced saleDraft into a committable ResolvedSaleDraft
// using the business-assistant catalog context — eliminating the second
// model call to /api/parse-sale.
//
// Inputs:
//   - draft:      the model's saleDraft (customerName + items)
//   - products:   full catalog with {id, name, sku, price?}
//   - customers:  full catalog with {id, name}
//
// Outputs:
//   - resolved:          items mapped to real products, customer matched
//   - ambiguous_customer: ≥2 customers match the name → client must pick
//   - empty:             no items resolved (items array empty or all skipped)
export async function extractSaleDraft(
  draft: SaleDraftInput | null | undefined,
  products: CatalogProduct[],
  customers: Array<{ id: string; name: string }>,
  userText?: string,
  businessId?: string,
): Promise<ExtractorResult> {
  if (!draft || !Array.isArray(draft.items) || draft.items.length === 0) {
    return { kind: "empty", reason: "no_draft" };
  }

  const resolvedItems: ResolvedSaleItem[] = [];
  const skipped: string[] = [];
  let sawValidQuantity = false;

  for (const item of draft.items) {
    const rawProductName = item.productName;
    const productName = typeof rawProductName === "string"
      ? rawProductName.trim()
      : String(rawProductName ?? "").trim();
    if (!productName) continue;

    const quantity = toNumber(item.quantity);
    if (quantity === null || quantity <= 0) {
      skipped.push(productName);
      continue;
    }
    sawValidQuantity = true;

    // matchProductByNameSemantic runs SQL fuzzy first (no Vertex call on hit),
    // then falls back to Vertex AI Search only on a SQL miss. This is the
    // slow path (post-LLM), so the additional latency on a Vertex fallback is
    // acceptable. Failures degrade gracefully to null (same as SQL-only miss).
    const matched = await matchProductByNameSemantic(productName, products, businessId).catch(() => null);
    if (!matched) {
      skipped.push(productName);
      continue;
    }

    // Defensa anti-alucinación del LLM: si el match tiene tokens
    // discriminadores ("usadas", "premium", "rojo") que NO aparecen en
    // el texto que escribió el usuario, loggeamos warning. Modo soft
    // (no bloquea venta) — primero medimos en tráfico real, después
    // endurecemos a clarification forzada si el contador sube.
    if (userText) {
      const validation = validateProductMatch(matched.name, userText);
      if (validation.kind === "discriminator_missing") {
        reportWarning(`sale.product-match.suspect: matched ${matched.name} but missing tokens: ${validation.missing.join(", ")}`, { scope: "sale.product-match.suspect", matchedProductId: matched.id, matchedProductName: matched.name, userText: userText.slice(0, 200), missing: validation.missing });
      }
    }

    const unitPrice = resolvePrice(item.unitPrice, matched.price);
    const subtotal = unitPrice !== null ? unitPrice * quantity : null;

    resolvedItems.push({
      productId: matched.id,
      productName: matched.name,
      quantity,
      unitPrice,
      subtotal,
    });
  }

  if (resolvedItems.length === 0) {
    return {
      kind: "empty",
      reason: sawValidQuantity ? "no_items_resolved" : "no_quantity",
    };
  }

  const rawCustomerName = draft.customerName;
  const customerQuery = typeof rawCustomerName === "string"
    ? rawCustomerName.trim()
    : String(rawCustomerName ?? "").trim();
  const isConsumidorFinal =
    !customerQuery ||
    /^(consumidor\s+final|sin\s+cliente|cliente\s+desconocido)$/i.test(customerQuery);

  // Normalize the taxId from the draft (strip formatting, keep only digits or null).
  const rawTaxId = typeof draft.taxId === "string" ? draft.taxId.trim() : null;
  const taxId = rawTaxId && rawTaxId.length > 0 ? rawTaxId : null;

  if (isConsumidorFinal) {
    return buildResolved({ id: null, name: "Consumidor Final" }, null, resolvedItems, skipped);
  }

  const customerMatch = findBestCustomerMatch(customerQuery, customers);
  if (customerMatch.ambiguous) {
    const candidates = getProductCandidates(customerQuery, customers, MAX_CUSTOMER_CANDIDATES);
    return {
      kind: "ambiguous_customer",
      query: customerQuery,
      candidates: candidates.length > 0 ? candidates : customers.slice(0, MAX_CUSTOMER_CANDIDATES),
    };
  }

  if (customerMatch.match) {
    return buildResolved(
      { id: customerMatch.match.id, name: customerMatch.match.name },
      taxId,
      resolvedItems,
      skipped
    );
  }

  // Semantic customer fallback: pgvector cosine search for freeform descriptions
  // ("la chica de las plantas", "el del pet shop"). Only runs when:
  //   - businessId is available (per-tenant embedding scope required)
  //   - embeddings are enabled (USE_EMBEDDINGS=true)
  //   - name-based matching already failed (SQL fuzzy miss above)
  // Similarity threshold ≥0.75 keeps precision high; lower scores fall through
  // to Consumidor Final rather than risk mis-attributing the sale.
  // A Vertex/DB failure degrades gracefully to Consumidor Final (catch → null).
  if (businessId) {
    const SEMANTIC_CUSTOMER_THRESHOLD = 0.75;
    const semanticHits = await findCustomersByDescription({
      businessId,
      description: customerQuery,
      topK: 3,
    }).catch(() => null);
    if (semanticHits && semanticHits.length > 0) {
      const top = semanticHits[0];
      if (top.similarity >= SEMANTIC_CUSTOMER_THRESHOLD) {
        const catalogHit = customers.find((c) => c.id === top.id);
        if (catalogHit) {
          return buildResolved(
            { id: catalogHit.id, name: catalogHit.name },
            taxId,
            resolvedItems,
            skipped,
          );
        }
      }
    }
  }

  // Fall back to Consumidor Final when no customer match — mirrors
  // parse-sale behavior so the flow doesn't block on unknown names.
  // Do NOT forward the raw customerQuery as the name: it is an unvalidated
  // user string that was never matched against the catalog, and writing it
  // to the sale would silently corrupt customer attribution.
  return buildResolved({ id: null, name: "Consumidor Final" }, taxId, resolvedItems, skipped);
}

function buildResolved(
  customer: { id: string | null; name: string },
  taxId: string | null,
  items: ResolvedSaleItem[],
  skipped: string[]
): ResolvedSaleDraft {
  const total = items.reduce((acc, item) => acc + (item.subtotal ?? 0), 0);
  return { kind: "resolved", customer, taxId, items, skipped, total };
}
