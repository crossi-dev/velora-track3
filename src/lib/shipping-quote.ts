// Shared shipping-quote helper — moved here from the payments agent _lib folder
// so it can be reused by both the Payments Agent tool and the call_ventas_agent
// pre-resolver without creating a lib → app/api import direction inversion.
//
// Design constraints:
// - Origin postal code: Business.postalCode (required). If missing, returns an
//   error so the caller can ask the owner to configure it. Never invented.
// - Destination postal code: Customer.postalCode preferred; falls back to the
//   postalCode supplied inline by the caller. If neither resolves, returns an
//   error that propagates to the owner as a clarification request.
// - Weight: derived from the sale's SaleItems → Product.weightGrams when saleId
//   is provided. Falls back to 500 g/item for products without a weight, and to
//   the DEFAULT_WEIGHT_GRAMS constant when no saleId is available. This matches
//   the get_package_profile tool logic in the Logística agent.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendStructured, A2AClientError } from "@/lib/a2a-client";
import { signAgentAssertion } from "@/lib/agent-identity";
import { deriveA2AKey } from "@/app/api/a2a/jsonrpc/_lib/handle-rpc";
import { cloudLog } from "@/lib/cloud-logger";
import { SHIPPING_QUOTE_TIMEOUT_MS } from "@/lib/agent-timeouts";
import { getAgentsBaseUrl } from "@/lib/agent-base-url";

/** Fallback weight used when no sale context is available. */
const DEFAULT_WEIGHT_GRAMS = 1_000;
/** Per-item fallback when a product has no weightGrams set. */
const GRAMS_PER_ITEM_DEFAULT = 500;

export interface ShippingAddressSnapshot {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  phone: string;
}

export type ShippingQuoteResult =
  | { ok: true; costARS: number; addressSnapshot: ShippingAddressSnapshot; resolvedCustomerId: string | null }
  | { ok: false; reason: "missing_origin_postal_code" | "missing_destination_postal_code" | "logistica_error"; detail?: string };

export interface ResolveShippingInput {
  businessId: string;
  /**
   * Canonical customer ID (SSOT: Customer.postalCode per DB row).
   * When provided, customer data is resolved via findUnique — no fuzzy name match.
   * Preferred over customerName whenever the caller already has the resolved ID
   * (e.g. Payments Agent create_payment_link tool after resolving customerId from
   * the Supervisor annotation).
   */
  customerId?: string | null;
  customerName?: string | null;
  /** CP supplied inline (from owner's request). Used only when Customer has none. */
  inlinePostalCode?: string | null;
  /** Street address supplied inline (from owner's request). Used only when Customer has none. */
  inlineAddress?: string | null;
  /**
   * Velora Sale ID. When provided, weight is derived from SaleItem → Product.weightGrams.
   * Falls back to 500 g/item for products without a weight field.
   * When absent, defaults to DEFAULT_WEIGHT_GRAMS (1 000 g).
   */
  saleId?: string | null;
}

/**
 * Validates an Argentine postal code: old 4-digit CPA ("5500") OR new
 * alphanumeric CPA ("C1414AJO" = letter + 4 digits + 3 letters). The old
 * /^\d{4,5}$/ rejected every new-format code (most of CABA) and accepted
 * 5-digit US ZIPs. Source: Correo Argentino CPA spec.
 */
export function isValidPostalCode(cp: string | null | undefined): cp is string {
  return typeof cp === "string" && /^([A-Za-z]\d{4}[A-Za-z]{3}|\d{4})$/.test(cp.trim());
}

/**
 * Derive total shipment weight in grams from a sale's items.
 * Mirrors get_package_profile tool: uses Product.weightGrams per item;
 * falls back to GRAMS_PER_ITEM_DEFAULT for products without a weight.
 */
async function deriveWeightFromSale(saleId: string): Promise<number> {
  try {
    const items = await prisma.saleItem.findMany({
      where: { saleId },
      select: { quantity: true, product: { select: { weightGrams: true } } },
    });
    if (items.length === 0) return DEFAULT_WEIGHT_GRAMS;
    return items.reduce((total, si) => {
      const grams = si.product?.weightGrams ?? null;
      return total + si.quantity * (grams !== null && grams > 0 ? grams : GRAMS_PER_ITEM_DEFAULT);
    }, 0);
  } catch {
    return DEFAULT_WEIGHT_GRAMS;
  }
}

export async function resolveShippingQuote(
  input: ResolveShippingInput,
): Promise<ShippingQuoteResult> {
  const { businessId, customerId, customerName, inlinePostalCode, inlineAddress, saleId } = input;

  // 1. Load business origin postal code.
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { postalCode: true },
  });
  const originCP = business?.postalCode?.trim() ?? null;
  if (!isValidPostalCode(originCP)) {
    return { ok: false, reason: "missing_origin_postal_code" };
  }

  // 2. Resolve customer data (address, postalCode, city, phone).
  // Priority: customerId (exact match) > customerName (fuzzy contains).
  // Customer.postalCode is the SSOT for shipping destination — never ask the owner
  // if the DB row already has it (Velora invariant: customer.postalCode stored at
  // onboarding / first sale with envío; canonical data per path-juan playbook §Customer).
  // findFirst with businessId: defense-in-depth tenant guard (M4 fix).
  let customer: { id: string; name: string; address: string | null; postalCode: string | null; city: string | null; phone: string | null } | null = null;
  if (customerId) {
    customer = await prisma.customer.findFirst({
      where: { id: customerId, businessId },
      select: { id: true, name: true, address: true, postalCode: true, city: true, phone: true },
    });
  } else if (customerName) {
    // Use diacritic + typo-tolerant matching via f_unaccent + pg_trgm similarity.
    // Replaces the previous ILIKE (contains/insensitive) which had no diacritic folding —
    // "Juan" would not match a customer stored as "Juan".
    // Sources: https://www.postgresql.org/docs/current/unaccent.html
    //          https://www.postgresql.org/docs/current/pgtrgm.html
    // Migration: prisma/migrations/20260527230119_unaccent_pgtrgm/migration.sql
    const rows = await prisma.$queryRaw<
      { id: string; name: string; address: string | null; postalCode: string | null; city: string | null; phone: string | null }[]
    >`
      SELECT id, name, address, "postalCode", city, phone
      FROM "Customer"
      WHERE "businessId" = ${businessId}
        AND f_unaccent(name) % f_unaccent(${customerName})
        AND similarity(f_unaccent(name), f_unaccent(${customerName})) > 0.4
      ORDER BY similarity(f_unaccent(name), f_unaccent(${customerName})) DESC
      LIMIT 1
    `;
    customer = rows[0] ?? null;
  }

  // 3. Determine destination postal code: Customer > inline.
  const destCP = isValidPostalCode(customer?.postalCode)
    ? customer!.postalCode!.trim()
    : isValidPostalCode(inlinePostalCode)
      ? inlinePostalCode!.trim()
      : null;

  if (!destCP) {
    return { ok: false, reason: "missing_destination_postal_code" };
  }

  // 4. Build address snapshot for shipment.create (stored in PaymentIntent.shippingAddress).
  const addressSnapshot: ShippingAddressSnapshot = {
    name: customer?.name ?? customerName ?? "",
    street: customer?.address ?? inlineAddress ?? "",
    postalCode: destCP,
    city: customer?.city ?? "",
    phone: customer?.phone ?? "",
  };

  // 5. Derive shipment weight: from sale items when saleId provided; default otherwise.
  const weightGrams = saleId
    ? await deriveWeightFromSale(saleId)
    : DEFAULT_WEIGHT_GRAMS;

  // 6. Call Logística agent for shipment.quote.
  const agentUrl = `${getAgentsBaseUrl()}/api/agents/logistica/jsonrpc`;
  const a2aSecret = process.env.A2A_SECRET ?? "";
  const derivedKey = a2aSecret ? deriveA2AKey(a2aSecret, businessId) : undefined;

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "PAYMENTS_SHIPPING_QUOTE",
    a2a_transfer: true,
    message: `Payments → Logística: shipment.quote origin=${originCP} dest=${destCP}`,
    data: { businessId, originCP, destCP, weightGrams, saleId: saleId ?? null },
  });

  try {
    const reply = await sendStructured(
      agentUrl,
      {
        skill: "shipment.quote",
        businessId,
        originPostalCode: originCP,
        destinationPostalCode: destCP,
        weightGrams,
        declaredValue: 0,
      },
      {
        apiKey: derivedKey,
        // Factory — fresh JWT per attempt to prevent JTI replay on retries.
        agentAssertionFactory: () => signAgentAssertion("payments", "logistica"),
        timeoutMs: SHIPPING_QUOTE_TIMEOUT_MS,
      },
    );

    // Parse cost from reply text. The mock and Andreani adapters both return
    // JSON inside the parts[].text field. Extract the cheapest numeric "price".
    const costARS = extractCheapestPrice(reply.text);
    if (costARS === null) {
      return { ok: false, reason: "logistica_error", detail: "no_price_in_reply" };
    }

    return { ok: true, costARS, addressSnapshot, resolvedCustomerId: customer?.id ?? null };
  } catch (err) {
    const detail = err instanceof A2AClientError
      ? `code=${err.code ?? "?"}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PAYMENTS_SHIPPING_QUOTE_FAILED",
      a2a_transfer: false,
      message: "shipment.quote failed",
      data: { businessId, error: detail },
    });
    return { ok: false, reason: "logistica_error", detail };
  }
}

/**
 * Extracts the cheapest numeric price from the Logística reply text (JSON blob).
 *
 * Canonical Andreani/mock contract (QuoteResult from types.ts):
 *   { options: [{ priceARS: number, service, serviceLabel, estimatedDays }, ...], ... }
 *
 * Legacy / alternative field names also accepted for forward-compatibility:
 *   options[].price  — in case a future adapter normalises to a generic name
 *   services[].price — previous parser expectation (kept as fallback)
 *   services[].priceARS — symmetry with options shape
 */
// Schema-validated reply shape (Google/industry standard: validate A2A replies,
// don't scrape free text). priceARS canonical, price as forward-compat fallback.
// .catch(undefined) makes each price field resilient to non-numeric values (e.g.
// "gratis", null) — the field is stripped to undefined rather than failing the
// whole parse. This lets extractCheapestPrice ignore bad items and still return
// the cheapest valid price from the remaining services.
const QuoteOptionSchema = z.object({
  priceARS: z.number().positive().optional().catch(undefined),
  price: z.number().positive().optional().catch(undefined),
});
const QuoteReplySchema = z.object({
  options: z.array(QuoteOptionSchema).optional(),
  services: z.array(QuoteOptionSchema).optional(),
});

/** Robust JSON extraction: whole-string first, then the first balanced {...} span. */
function parseJsonLoose(text: string): unknown {
  try { return JSON.parse(text); } catch { /* try brace span */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function extractCheapestPrice(text: string): number | null {
  const result = QuoteReplySchema.safeParse(parseJsonLoose(text));
  if (!result.success) return null;
  const items = result.data.options ?? result.data.services ?? [];
  // .positive() already drops zero/negative prices (guards $0 shipping).
  const prices = items
    .map((o) => o.priceARS ?? o.price ?? null)
    .filter((p): p is number => p !== null && p > 0);
  return prices.length > 0 ? Math.min(...prices) : null;
}
