// Step 1.5c: SSR capability map per Stripe Incremental currently_due pattern.
// Source: https://docs.stripe.com/connect/custom/hosted-onboarding
// "currently_due requirements request only the user information needed for
//  verification at this specific point in time"
//
// Capabilities are loaded server-side so the CapabilityBuoyBanner has
// fresh data on every navigation without a client-side fetch waterfall.

import { Suspense, cache } from "react";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { verifyEmployeeSession, EMPLOYEE_COOKIE_NAME } from "@/lib/employee-auth-edge";
import { loadBusinessCapabilities, type BusinessCapabilities } from "@/lib/business-capabilities";
import DashboardPage from "./DashboardPage";
import type { ActorRole } from "./lib/contexts";

// Dedupe the NextAuth session decode within a single request: detectRole() and
// resolveOwnerBusinessId() both call auth(). React cache() collapses the two
// JWT decodes into one per request (no cross-request state — cache is per-request).
const cachedAuth = cache(auth);

async function detectRole(): Promise<ActorRole> {
  const jar = await cookies();
  const empCookie = jar.get(EMPLOYEE_COOKIE_NAME)?.value ?? null;
  if (empCookie) {
    const emp = await verifyEmployeeSession(empCookie);
    if (emp?.payload) return "employee";
  }
  const session = await cachedAuth();
  if (session?.user?.id) return "owner";
  return "owner"; // middleware guards unauthenticated — fallback is safe
}

/**
 * Resolves the businessId for an owner session.
 * Returns null for employee sessions (no business lookup needed — banner is owner-only).
 */
async function resolveOwnerBusinessId(): Promise<string | null> {
  const session = await cachedAuth();
  if (!session?.user?.id) return null;
  const biz = await prisma.business.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  return biz?.id ?? null;
}

function DashboardSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1.5rem 0" }}>
      <div className="shimmer" style={{ width: "100%", height: "80px" }} />
      <div className="shimmer" style={{ width: "100%", height: "48px" }} />
      <div className="shimmer" style={{ width: "100%", height: "48px" }} />
      <div className="shimmer" style={{ width: "100%", height: "48px" }} />
      <div className="shimmer" style={{ width: "100%", height: "48px" }} />
    </div>
  );
}

export default async function Page() {
  // Run role detection and (for owner) capability loading in parallel.
  const [role, businessId] = await Promise.all([
    detectRole(),
    resolveOwnerBusinessId(),
  ]);

  let capabilities: BusinessCapabilities | null = null;
  if (role === "owner" && businessId) {
    // Fail-open: if capabilities loading fails (DB hiccup), the banner simply
    // won't render — the dashboard itself is unaffected.
    try {
      capabilities = await loadBusinessCapabilities(businessId);
    } catch {
      // Non-critical — banner is enhancement, not core UI.
      capabilities = null;
    }
  }

  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardPage role={role} capabilities={capabilities} />
    </Suspense>
  );
}
