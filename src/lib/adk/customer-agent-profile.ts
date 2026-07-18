import "server-only";
// customer-agent-profile.ts — loads the saved customer row and builds the profile
// summary string injected into the Customer Agent instruction. Mirrors
// customer-agent-catalog.ts: a compact context block so the agent stops re-asking
// name/address/CP it already has.
import { prisma } from "@/lib/prisma";

export interface CustomerProfileRow {
  id: string;
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}

const fieldOrFalta = (v: string | null | undefined): string =>
  v && v.trim().length > 0 ? v.trim() : "(falta)";

// A brand-new customer row is created by the wpp worker with name = phone (no real
// name yet). Treat a phone-like name (only +/digits/spaces/()-) as missing so the
// agent captures the real name opportunistically instead of echoing the number.
const PHONE_LIKE = /^[+\d\s()-]+$/;
const nameOrFalta = (v: string | null | undefined): string => {
  const t = (v ?? "").trim();
  return t.length === 0 || PHONE_LIKE.test(t) ? "(falta)" : t;
};

/**
 * Build the compact profile summary injected via CUSTOMER_PROFILE_PLACEHOLDER.
 * Empty fields are marked "(falta)" so the model knows exactly what to ask for.
 * A null row (brand-new customer) yields the "no data yet" line.
 */
export function buildCustomerProfileSummary(
  row: CustomerProfileRow | null,
): string {
  if (!row) return "Cliente nuevo — sin datos guardados aún.";
  return `Nombre: ${nameOrFalta(row.name)} | Dirección: ${fieldOrFalta(row.address)} | CP: ${fieldOrFalta(row.postalCode)} | Ciudad: ${fieldOrFalta(row.city)}`;
}

/**
 * Look up the saved customer row by phone (tenant-scoped) and build its summary.
 * Returns both the row (for customerId/name reuse) and the injectable summary.
 */
export async function loadCustomerProfile(
  businessId: string,
  customerPhone: string,
): Promise<{ row: CustomerProfileRow | null; summary: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma regen blocked on Windows DLL lock.
  const row = await (prisma as any).customer.findFirst({
    where: { businessId, phone: customerPhone },
    select: { id: true, name: true, address: true, postalCode: true, city: true },
  }) as CustomerProfileRow | null;
  return { row, summary: buildCustomerProfileSummary(row) };
}
