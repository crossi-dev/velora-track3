import "server-only";
// execute-payment-link-fast-path-helpers.ts
//
// Pure helpers and lightweight DB lookup extracted from
// execute-payment-link-fast-path.ts to keep that file under 250 LOC.
//
// Exports:
//   - extractUrl              — extracts first https:// URL from a string
//   - lookupCustomerByName    — single-row DB read (no side-effects)
//   - buildPaymentLinkChips   — builds the send-via-WA chip bundle

import { prisma } from "@/lib/prisma";
import type { CustomerSnapshot } from "@/lib/adk/tools/resolve-ventas-shipping";
import type { ChipsBundle } from "@/app/api/supervisor/_lib/supervisor-chips";

// Extracts the first https:// URL in a text string (same helper as call-ventas-agent-tool).
export function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s"'<>]+/);
  if (!match) return null;
  return match[0].replace(/[.,;:!?)\]]+$/, "");
}

/**
 * Looks up customer by name for the non-shipping path (no shipping pre-resolve runs).
 *
 * Uses diacritic + typo-tolerant matching via PostgreSQL unaccent + pg_trgm similarity
 * (% operator). Replaces the previous ILIKE which had no diacritic folding.
 *
 * Sources: https://www.postgresql.org/docs/current/unaccent.html
 *          https://www.postgresql.org/docs/current/pgtrgm.html
 * Migration: prisma/migrations/20260527230119_unaccent_pgtrgm/migration.sql
 */
export async function lookupCustomerByName(
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

/**
 * Builds the single send chip.
 * Returns null when the customer has no phone (can't send via WhatsApp).
 *
 * @param paymentIntentId - DB id of the PaymentIntent that holds the checkout URL.
 *   Stored instead of the URL itself because the chip value schema has an 80-char
 *   limit and MP init_point URLs routinely exceed it.
 */
export function buildPaymentLinkChips(
  snap: CustomerSnapshot,
  paymentIntentId: string,
): ChipsBundle | null {
  if (!snap.phone) return null;
  const firstName = snap.name.split(" ")[0] ?? snap.name;
  // Pipe-delimited value: intent|phone|paymentIntentId
  // paymentIntentId is a cuid (~25 chars) — well within the 80-char limit.
  return {
    kind: "single",
    options: [
      {
        label: `📲 Enviar a ${firstName}`,
        value: `enviar_link_pago|${snap.phone}|${paymentIntentId}`,
      },
    ],
  };
}
