// Demo tester allowlist — owners whose businesses ALWAYS emit simulated
// invoices regardless of the global ARCA_REAL_MODE flag.
//
// Why this exists: Carlos and the gestiones account demo the app live to
// investors and franchisees. Emitting real legal invoices to fictitious
// customers during those demos would create both legal and accounting
// problems (registered with ARCA, counted toward monotributo, etc.).
// Keeping these accounts in mock mode insulates the live demo from prod
// emission, while letting every other business follow the global flag.
//
// Add or remove emails here. No deploy gymnastics needed beyond the
// commit + Cloud Run roll. Future: migrate to a Cloud Run env var list
// (`DEMO_TESTER_EMAILS=a@b.com,c@d.com`) so non-engineers can toggle.

import { prisma } from "@/lib/prisma";

const DEMO_TESTER_EMAILS: ReadonlySet<string> = new Set([
  "owner@example.com",
  "contact@example.com",
  "tester@example.com",
]);

export function isDemoTesterEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return DEMO_TESTER_EMAILS.has(email.trim().toLowerCase());
}

/** True when the business' owner email is in the demo-tester allowlist. */
export async function isBusinessDemoTester(businessId: string): Promise<boolean> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { user: { select: { email: true } } },
  });
  return isDemoTesterEmail(business?.user?.email ?? null);
}
