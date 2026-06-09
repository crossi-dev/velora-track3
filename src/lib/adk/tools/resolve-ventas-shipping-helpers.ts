// resolve-ventas-shipping-helpers.ts
//
// Pure helpers and single DB lookup extracted from resolve-ventas-shipping.ts
// to keep that file under 250 LOC.
//
// Exports:
//   - CUSTOMER_NAME_RE       — regex pattern (exported for tests)
//   - SHIPPING_RE             — regex for detecting shipping intent
//   - extractCustomerNameFromMessage — pure string helper
//   - lookupCustomerSnapshot  — single-row DB read with no side-effects
//   - persistExtractedFields  — fill-nulls-only Customer update after NER extraction

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import type { CustomerSnapshot } from "./resolve-ventas-shipping";
import type { ShippingEntities } from "./extract-shipping-entities";

// ── Customer name extraction ─────────────────────────────────────────────────
// Extracts a candidate customer name from a free-text message.
// Looks for "para <Name>" or "a <Name>" patterns (most common in Spanish business
// requests). Returns null when the pattern is not found — the caller falls back
// to forwarding the message unchanged so the Payments Agent can surface a clear
// missing-customer error rather than asking for postal code.
//
// Multi-word suffix requires subsequent words to start with an UPPERCASE letter
// so stop-words like "por", "wpp", "via", "con", "whatsapp" are not captured as
// part of the name. "María García" (capital G) is captured correctly; "Carlos por
// wpp" stops at lowercase "p" and returns just "Carlos".
// Root cause fix (2026-05-20): the previous regex used [A-ZÁÉÍÓÚÑÜa-záéíóúüñ] for
// the first char of subsequent name words, which includes lowercase — so stop-words
// were greedily appended, causing lookupCustomerByName("Carlos por wpp") → null → no chip.
export const CUSTOMER_NAME_RE =
  /\b(?:para|a)\s+([A-ZÁÉÍÓÚÑÜa-záéíóúüñ][a-záéíóúüñ]+(?:\s+[A-ZÁÉÍÓÚÑÜ][a-záéíóúüñ]+)*)/;

export function extractCustomerNameFromMessage(message: string): string | null {
  const match = message.match(CUSTOMER_NAME_RE);
  return match?.[1]?.trim() ?? null;
}

// ── Shipping intent detector ─────────────────────────────────────────────────
// Detects shipping intent — same regex as resolve-ventas-amount.ts.
export const SHIPPING_RE =
  /\b(env[ií]o|env[ií]a|despacho|con\s+env[ií]o|gastos\s+de\s+env[ií]o|shipping)\b/i;

// ── Customer DB lookup ───────────────────────────────────────────────────────
/**
 * Looks up a customer by name within a business using diacritic + typo-tolerant
 * matching via PostgreSQL unaccent + pg_trgm similarity (% operator).
 *
 * Replaces the previous ILIKE (mode: "insensitive") which had no diacritic folding —
 * "Juan" would not match a customer stored as "Juan".
 *
 * Sources: https://www.postgresql.org/docs/current/unaccent.html
 *          https://www.postgresql.org/docs/current/pgtrgm.html
 * Migration: prisma/migrations/20260527230119_unaccent_pgtrgm/migration.sql
 */
export async function lookupCustomerSnapshot(
  businessId: string,
  customerName: string,
): Promise<CustomerSnapshot | null> {
  if (!customerName) return null;
  const rows = await prisma.$queryRaw<
    { id: string; name: string; phone: string | null; address: string | null; postalCode: string | null; city: string | null }[]
  >`
    SELECT id, name, phone, address, "postalCode", city
    FROM "Customer"
    WHERE "businessId" = ${businessId}
      AND f_unaccent(name) % f_unaccent(${customerName})
    ORDER BY similarity(f_unaccent(name), f_unaccent(${customerName})) DESC
    LIMIT 1
  `;
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    address: row.address ?? null,
    postalCode: row.postalCode ?? null,
    city: row.city ?? null,
  };
}

// ── Extracted-field persistence ──────────────────────────────────────────────
/**
 * Persists NER-extracted shipping fields to an existing Customer row.
 *
 * Fill-nulls-only policy: only writes a field when the current DB value is null
 * AND the extracted value is a non-empty string. Never overwrites existing data.
 * If all DB fields are already populated, no DB write occurs.
 *
 * Pattern: progressive data collection — enrich at first encounter, reuse forever.
 * Reference: https://docs.stripe.com/connect/required-verification-information
 *   (confirmed HTTP 200: "currently_due" shows incremental verification model)
 *
 * @param customerId   - Prisma Customer.id (already resolved by lookupCustomerSnapshot)
 * @param snapshot     - Current DB values for the customer (from lookupCustomerSnapshot)
 * @param entities     - Fields extracted by extractShippingEntities
 * @param businessId   - For audit log only
 */
export async function persistExtractedFields(
  customerId: string,
  snapshot: CustomerSnapshot,
  entities: ShippingEntities,
  businessId: string,
): Promise<void> {
  // Determine which fields need filling: extracted non-empty + DB currently null.
  const data: Record<string, string> = {};
  if (!snapshot.address   && entities.address)   data.address    = entities.address;
  if (!snapshot.postalCode && entities.postalCode) data.postalCode = entities.postalCode;
  if (!snapshot.city      && entities.city)       data.city       = entities.city;

  if (Object.keys(data).length === 0) return; // nothing to write

  try {
    // Defense-in-depth: scope by businessId (customerId resolved within this tenant).
    await prisma.customer.updateMany({ where: { id: customerId, businessId }, data });
    cloudLog({
      severity:    "INFO",
      component:   "Supervisor",
      action:      "CUSTOMER_FIELDS_ENRICHED",
      a2a_transfer: false,
      message:     "persistExtractedFields: customer row enriched from NER",
      data:        { businessId, customerId, fields: Object.keys(data) },
    });
  } catch (err) {
    // Non-fatal — enrichment is best-effort. The shipping quote proceeds regardless.
    cloudLog({
      severity:    "WARNING",
      component:   "Supervisor",
      action:      "CUSTOMER_FIELDS_ENRICH_FAILED",
      a2a_transfer: false,
      message:     "persistExtractedFields: DB update failed — shipping continues",
      data:        { businessId, customerId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
