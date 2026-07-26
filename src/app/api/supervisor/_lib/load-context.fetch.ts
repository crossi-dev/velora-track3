// Fetches SupervisorBusinessContext from the DB for a given businessId.
// Extracted from load-context.ts to keep that file under 300 LOC.
// Called exclusively by loadSupervisorContext — not exported for direct use.

import { prisma } from "@/lib/prisma";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";
import { reportWarning } from "@/lib/cloud-logger";
import type { SupervisorBusinessContext } from "./load-context";

export async function fetchSupervisorContext(businessId: string): Promise<SupervisorBusinessContext> {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  // Critical context: chat cannot function without these. Promise.all means a
  // failure here legitimately throws (the caller's error boundary catches it).
  const criticalLoad = Promise.all([
    prisma.businessRule.findMany({
      where: { businessId, active: true },
      select: { kind: true, trigger: true, message: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.delegationPolicy.findMany({
      where: { businessId, active: true },
      select: { scope: true, maxValue: true, requiresOwner: true, conditions: true },
    }),
    prisma.product.findMany({
      where: buildActiveProductWhere({ businessId }),
      select: { id: true, name: true, price: true, quantity: true },
      orderBy: { name: "asc" },
      take: 50,
    }),
    // Employee concept removed (0 rows in production, Stage 1 cleanup) — no
    // employee audience left to load context for.
    Promise.resolve([] as Array<{ name: string; role: string }>),
    prisma.business.findUnique({
      where: { id: businessId },
      select: {
        currency: true,
        name: true,
        type: true,
        paymentMethods: true,
        openingCashConfigured: true,
        mercadoPagoOnboardingDeferred: true,
        customersOnboardingSkipped: true,
        arcaOnboardingDeferred: true,
        andreaniOnboardingDeferred: true,
        pendingStockProductId: true,
        postalCode: true,
        courierPreference: true,
        alias: true,
        whatsappPhone: true,
        cuit: true,
        ivaCondition: true,
        puntoVenta: true,
        // BYOA fields — used to derive arcaCertConnected and courierCredentialsConnected
        // when the owner uses the portal-redirect pattern instead of cert upload.
        arcaDelegationCuit: true,
        arcaDelegationPendingStep: true,
        andreaniApiToken: true,
        andreaniTokenPendingStep: true,
        // Onboarding redesign 2026-05-25 flags.
        skippedCatalog: true,
        firstSalePromptShown: true,
      },
    }),
    prisma.cashMovement.aggregate({
      where: { businessId },
      _sum: { amount: true },
    }),
    prisma.chatMessage.findMany({
      where: { businessId, ackedAt: { not: null }, createdAt: { gte: todayStart } },
      select: { text: true },
      orderBy: { ackedAt: "desc" },
      take: 10,
    }),
  ]);

  // Optional integration checks + customerCount: each only feeds a boolean flag
  // or count downstream. A transient failure on any of these should NOT 500 the
  // entire chat — just treat as "not connected" / 0. Source: debt audit C3.
  // PERF-T3-3: customerCount moved into this parallel group to eliminate the
  // sequential DB round-trip that previously ran after criticalLoad + optionalSettled
  // both resolved, adding ~5ms serially on every context cache miss.
  const optionalSettled = Promise.allSettled([
    prisma.mpConnection.findUnique({
      where: { businessId },
      select: { id: true },
    }),
    prisma.arcaCredential.findUnique({
      where: { businessId },
      select: { id: true },
    }),
    prisma.courierCredential.findFirst({
      where: { businessId },
      select: { provider: true },
    }),
    prisma.modoConnection.findUnique({
      where: { businessId },
      select: { id: true },
    }),
    prisma.customer.count({ where: { businessId } }),
  ]);

  const [
    [rules, policies, products, employees, business, cashAgg, ackedMessages],
    [mpResult, arcaResult, courierResult, modoResult, customerCountResult],
  ] = await Promise.all([criticalLoad, optionalSettled]);

  const settledValue = <T>(r: PromiseSettledResult<T | null>): T | null =>
    r.status === "fulfilled" ? r.value : null;

  const mpConnection = settledValue(mpResult);
  const arcaCred = settledValue(arcaResult);
  const courierCred = settledValue(courierResult);
  const modoConn = settledValue(modoResult);

  // customerCount: optional — failure should not break chat. Treated as 0 on error.
  const customerCountValue = customerCountResult.status === "fulfilled" ? customerCountResult.value : 0;

  // Log any rejected optional fetch so we don't lose visibility into integration
  // outages — but the chat keeps working.
  for (const [name, r] of [
    ["mpConnection", mpResult],
    ["arcaCredential", arcaResult],
    ["courierCredential", courierResult],
    ["modoConnection", modoResult],
    ["customerCount", customerCountResult],
  ] as const) {
    if (r.status === "rejected") {
      reportWarning(`supervisor-context: optional fetch "${name}" failed — treating as not connected`, {
        businessId,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  if (rules.length === 20) {
    reportWarning("supervisor-context: active rules hit cap of 20 — business may have more rules not injected into LLM context", { businessId });
  }

  if (products.length === 50) {
    const totalCount = await prisma.product.count({ where: buildActiveProductWhere({ businessId }) });
    if (totalCount > 50) {
      reportWarning(
        `supervisor-context: product catalog truncated — Supervisor sees 50 of ${totalCount} active products; responses about unlisted SKUs will be incorrect`,
        { businessId, totalCount, loadedCount: 50 },
      );
    }
  }

  const mappedProducts = products.map((p) => ({
    id: p.id,
    name: p.name,
    price: Number(p.price),
    stock: p.quantity,
  }));

  // Build pendingStockProduct from Business.pendingStockProductId (set server-side
  // after T5 product creation). This supports multi-product onboarding: the field
  // is updated to point to each newly-created product until T5c/T5d clears it.
  const pendingProductId = business?.pendingStockProductId ?? null;
  const pendingStockProduct: { productId: string; name: string } | null = pendingProductId
    ? (mappedProducts.find((p) => p.id === pendingProductId) ?? null)
      ? { productId: pendingProductId, name: mappedProducts.find((p) => p.id === pendingProductId)!.name }
      : null
    : null;

  return {
    activeRules: rules,
    activePolicies: policies.map((p) => ({
      scope: p.scope,
      maxValue: p.maxValue !== null && p.maxValue !== undefined ? Number(p.maxValue) : null,
      requiresOwner: p.requiresOwner,
      conditions: p.conditions,
    })),
    products: mappedProducts,
    employees: employees.map((e) => ({ name: e.name, role: e.role })),
    cashBalance: Number(cashAgg._sum.amount ?? 0),
    currency: business?.currency ?? "ARS",
    productCount: mappedProducts.length,
    productsWithoutStock: mappedProducts.filter((p) => p.stock === 0).length,
    employeeCount: employees.length,
    ackedAlerts: ackedMessages.map((m) => ({ employeeName: "empleado", text: m.text })),
    businessNameSet: typeof business?.name === "string" && business.name.trim().length > 0,
    businessTypeSet: typeof business?.type === "string" && business.type.trim().length > 0,
    paymentMethodsSet: (business?.paymentMethods?.length ?? 0) > 0,
    openingCashSet: business?.openingCashConfigured === true,
    // transferAliasSet: true when Transferencia NOT in methods, OR alias is already set.
    // Guard: empty-string alias ("") is typeof "string" but is NOT configured.
    transferAliasSet:
      !(business?.paymentMethods ?? []).includes("Transferencia") ||
      (typeof business?.alias === "string" && business.alias.trim().length > 0),
    paymentMethodsIncludeTransferencia: (business?.paymentMethods ?? []).includes("Transferencia"),
    transferAlias: (typeof business?.alias === "string" && business.alias.trim().length > 0)
      ? business.alias.trim()
      : null,
    postalCodeSet: typeof business?.postalCode === "string" && /^\d{4,5}$/.test(business.postalCode.trim()),
    courierPreferenceSet: typeof business?.courierPreference === "string" && business.courierPreference.trim().length > 0,
    courierPreference: (typeof business?.courierPreference === "string" && business.courierPreference.trim().length > 0)
      ? business.courierPreference.trim()
      : null,
    whatsappPhoneSet: business?.whatsappPhone !== null && business?.whatsappPhone !== undefined,
    whatsappPhoneRaw: business?.whatsappPhone ?? null,
    pendingStockProduct,
    mercadoPagoSelected: (business?.paymentMethods ?? []).includes("Mercado Pago"),
    mercadoPagoConnected: mpConnection !== null,
    mercadoPagoOnboardingDeferred: business?.mercadoPagoOnboardingDeferred === true,
    originPostalCode: business?.postalCode?.trim() || null,
    businessName: (typeof business?.name === "string" && business.name.trim().length > 0)
      ? business.name.trim()
      : null,
    cuitSet: typeof business?.cuit === "string" && business.cuit.replace(/\D/g, "").length === 11,
    ivaConditionSet: typeof business?.ivaCondition === "string" && business.ivaCondition.trim().length > 0,
    puntoVentaSet: typeof business?.puntoVenta === "string" && business.puntoVenta.trim().length > 0,
    // arcaCertConnected: true when the business has either a full ARCA cert
    // credential row (classic path) OR a BYOA CUIT delegation (new path).
    arcaCertConnected: arcaCred !== null || (
      typeof business?.arcaDelegationCuit === "string" &&
      business.arcaDelegationCuit.trim().length > 0
    ),
    // courierCredentialsConnected:
    // - If the owner picked "ninguno" (no shipments), credentials are not
    //   required and the T_ANDREANI turn should be considered done.
    // - Otherwise: matches the owner's chosen courier against an actual
    //   credential row (classic path) OR a BYOA encrypted token (new path).
    courierCredentialsConnected:
      (typeof business?.courierPreference === "string" &&
        business.courierPreference.trim().toLowerCase() === "ninguno") ||
      (courierCred !== null &&
        typeof business?.courierPreference === "string" &&
        business.courierPreference.trim().toLowerCase() === courierCred.provider.trim().toLowerCase()) ||
      (typeof business?.andreaniApiToken === "string" &&
        business.andreaniApiToken.trim().length > 0 &&
        typeof business?.courierPreference === "string" &&
        business.courierPreference.trim().toLowerCase() === "andreani"),
    modoConnected: modoConn !== null,
    customerCount: customerCountValue,
    customersOnboardingSkipped: business?.customersOnboardingSkipped === true,
    arcaOnboardingDeferred: business?.arcaOnboardingDeferred === true,
    andreaniOnboardingDeferred: business?.andreaniOnboardingDeferred === true,
    // BYOA pending steps — null when not in a pending-credential state.
    arcaPendingStep: (typeof business?.arcaDelegationPendingStep === "string" &&
      business.arcaDelegationPendingStep.trim().length > 0)
      ? business.arcaDelegationPendingStep.trim()
      : null,
    andreaniPendingStep: (typeof business?.andreaniTokenPendingStep === "string" &&
      business.andreaniTokenPendingStep.trim().length > 0)
      ? business.andreaniTokenPendingStep.trim()
      : null,
    // Onboarding redesign 2026-05-25 flags.
    skippedCatalog: business?.skippedCatalog === true,
    firstSalePromptShown: business?.firstSalePromptShown === true,
  };
}
