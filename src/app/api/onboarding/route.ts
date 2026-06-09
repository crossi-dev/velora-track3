import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prisma } from "@/lib/prisma";
import { initializeBusinessOnboardingState } from "./_lib/business-recovery";
import {
  MAX_FIELD_LENGTH,
  parseStrictNonNegativeNumber,
  parseStrictNonNegativeInteger,
  type OnboardingBody,
} from "./_lib/validators";
import { normalizeInput, normalizeNullableInput } from "../../../lib/normalize";
import { seedProducts, seedCustomers, seedSuppliers } from "./_lib/initial-data";
import { handleGetOnboarding } from "./_lib/get-handler";

const MUTATION_ACTIONS = {
  POST: "onboarding.complete",
} as const satisfies RouteMutationDeclaration;
const ONBOARDING_COMPLETE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req);
    if (!actor) {
      return NextResponse.json({ code: "UNAUTHORIZED", message: "Necesitás iniciar sesión." }, { status: 401 });
    }
    if (actor.role !== "owner") {
      return NextResponse.json({ code: "FORBIDDEN", message: "Solo el dueño puede acceder a esto." }, { status: 403 });
    }

    return await handleGetOnboarding(actor.actorUserId);
  } catch (err) {
    logRouteError("onboarding:GET", err);
    return NextResponse.json(
      { code: "ONBOARDING_LOAD_FAILED", message: "No pudimos cargar la información del negocio." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const actor = await resolveActor(req);
  if (!actor) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Necesitás iniciar sesión." }, { status: 401 });
  }
  if (actor.role !== "owner") {
    return NextResponse.json({ code: "FORBIDDEN", message: "Solo el dueño puede acceder a esto." }, { status: 403 });
  }

  let body: OnboardingBody;
  let idempotencyRecordId: string | null = null;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "INVALID_JSON", message: "El cuerpo de la solicitud no es JSON válido." }, { status: 400 });
  }

  const { business, products, customers, suppliers } = body;
  const normalizedProducts: Array<{ name: string; price: number; stock: number }> = [];

  const normalizedBusinessName = normalizeInput(business?.name, MAX_FIELD_LENGTH);
  if (!normalizedBusinessName) {
    return NextResponse.json({ code: "MISSING_BUSINESS_NAME", message: "El nombre del negocio es obligatorio." }, { status: 422 });
  }

  const normalizedBusinessType = normalizeInput(business?.type, MAX_FIELD_LENGTH);
  if (!normalizedBusinessType) {
    return NextResponse.json({ code: "MISSING_BUSINESS_TYPE", message: "El tipo de negocio es obligatorio." }, { status: 422 });
  }

  const normalizedBusinessCurrency = normalizeInput(business?.currency, MAX_FIELD_LENGTH).toUpperCase().slice(0, 8) || "ARS";
  const normalizedBusinessCuit = normalizeNullableInput(business?.cuit, MAX_FIELD_LENGTH);
  if (normalizedBusinessCuit !== null && !/^\d{2}-?\d{8}-?\d$/.test(normalizedBusinessCuit)) {
    return NextResponse.json(
      { code: "INVALID_CUIT", message: "El formato del CUIT no es válido (esperado XX-XXXXXXXX-X)." },
      { status: 422 }
    );
  }

  const normalizedBusinessAddress = normalizeNullableInput(business?.address, MAX_FIELD_LENGTH);
  const normalizedBusinessPhone = normalizeNullableInput(business?.phone, MAX_FIELD_LENGTH);
  const normalizedWorkerCount = Math.max(0, Math.floor(Number(business?.workerCount) || 0));
  const normalizedOpeningCash = Math.max(0, Number(business?.openingCash) || 0);
  const TIME_RE = /^\d{2}:\d{2}$/;
  const normalizedOpeningTime = typeof business?.openingTime === "string" && TIME_RE.test(business.openingTime) ? business.openingTime : null;
  const normalizedClosingTime = typeof business?.closingTime === "string" && TIME_RE.test(business.closingTime) ? business.closingTime : null;

  if (products?.length) {
    for (const product of products) {
      const productName = product.name.trim();
      if (!productName) continue;

      const price = parseStrictNonNegativeNumber(product.price);
      if (price === null) {
        return NextResponse.json(
          { code: "INVALID_PRODUCT_PRICE", message: `El precio de "${productName}" debe ser un número mayor o igual a cero.` },
          { status: 422 }
        );
      }

      const stock = parseStrictNonNegativeInteger(product.stock);
      if (stock === null) {
        return NextResponse.json(
          { code: "INVALID_PRODUCT_STOCK", message: `El stock de "${productName}" debe ser un número entero mayor o igual a cero.` },
          { status: 422 }
        );
      }

      normalizedProducts.push({ name: productName, price, stock });
    }
  }

  try {
    const idempotency = await prismaIdempotencyAdapter.begin({
      businessId: `bootstrap:${actor.actorUserId}`,
      actionType: ONBOARDING_COMPLETE_ACTION.actionType,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: {
        businessName: normalizedBusinessName,
        businessType: normalizedBusinessType,
        currency: normalizedBusinessCurrency,
        cuit: normalizedBusinessCuit,
        productsCount: normalizedProducts.length,
        customersCount: customers?.length ?? 0,
        suppliersCount: suppliers?.length ?? 0,
      },
    });

    if (idempotency.kind === "replay") return NextResponse.json(idempotency.body, { status: idempotency.status });
    if (idempotency.kind !== "execute") return NextResponse.json({ code: "IDEMPOTENCY_ERROR", message: "Ya hay una operación en curso." }, { status: 422 });

    idempotencyRecordId = idempotency.recordId;

    // Use initializeBusinessOnboardingState (single creation path, design §3/§14.6).
    // Upserts on Business.userId (@unique) — safe when ensurePlaceholderBusiness
    // already created a stub row. The upsert overwrites stub fields (name="", type="")
    // with the real values; onboarding-flag defaults are left as-is (DB defaults hold).
    // Seeding (products/customers/suppliers) runs after the upsert via separate prisma calls
    // outside the business row creation itself (pgbouncer transaction-mode safe: batch, not interactive).
    const businessId = await initializeBusinessOnboardingState(actor.actorUserId, {
      name: normalizedBusinessName,
      type: normalizedBusinessType,
      currency: normalizedBusinessCurrency,
      cuit: normalizedBusinessCuit,
      address: normalizedBusinessAddress,
      phone: normalizedBusinessPhone,
      taxRate: 0,
      workerCount: normalizedWorkerCount,
      openingCash: normalizedOpeningCash,
      openingTime: normalizedOpeningTime,
      closingTime: normalizedClosingTime,
    });

    // Ensure the User row exists before seeding. Profile fields from OAuth session;
    // native-bearer path has userId only. upsert preserves an existing profile row.
    await prisma.user.upsert({
      where: { id: actor.actorUserId },
      update: {},
      create: { id: actor.actorUserId, email: null, name: null, image: null },
    });

    // Seed supplemental data via the prisma singleton. seedProducts/Customers/Suppliers
    // expect Prisma.TransactionClient; the extended PrismaClient is structurally
    // compatible for all operations used inside these helpers (create, update).
    // INV-5: cast justified — seeding runs post-business-upsert (not inside a tx);
    // the $extends() tenant extension adds only result transformers, no query rewrite.
    //
    // Retry-safety guard: seed helpers use `create` (not upsert), so a partial
    // failure + client retry would duplicate products/customers/suppliers.
    // Guard: skip seeding for an entity type if rows already exist for this business
    // (empty-business check). On retry the business already has rows → seeds are a
    // no-op. Counts run in parallel (cheap) before any seed write.
    const prismaSeed = prisma as unknown as Prisma.TransactionClient;
    const [existingProductCount, existingCustomerCount, existingSupplierCount] = await Promise.all([
      normalizedProducts.length ? prisma.product.count({ where: { businessId } }) : Promise.resolve(0),
      customers?.length ? prisma.customer.count({ where: { businessId } }) : Promise.resolve(0),
      suppliers?.length ? prisma.supplier.count({ where: { businessId } }) : Promise.resolve(0),
    ]);

    const seedOps: Promise<unknown>[] = [];
    if (normalizedProducts.length && existingProductCount === 0) {
      seedOps.push(seedProducts(prismaSeed, businessId, normalizedProducts));
    }
    if (customers?.length && existingCustomerCount === 0) {
      seedOps.push(seedCustomers(prismaSeed, businessId, customers));
    }
    if (suppliers?.length && existingSupplierCount === 0) {
      seedOps.push(seedSuppliers(prismaSeed, businessId, suppliers));
    }
    await Promise.all(seedOps);

    const result = { id: businessId };

    // Post-commit: business is already created. Both calls are best-effort —
    // failures are absorbed so a transient write error does not trigger
    // release() on an already-committed record.

    // 1. Idempotency completion — best-effort. A failure leaves the row
    //    "pending" until TTL prune; the unique-key still arbitrates retries.
    try {
      await prismaIdempotencyAdapter.complete(null, idempotencyRecordId!, 201, { businessId: result.id });
    } catch (idemErr) {
      logRouteError("onboarding:idempotency_complete", idemErr);
    }

    // 2. Audit write — best-effort. Business is committed; a failed audit
    //    write must not surface as an error to the caller or reach the
    //    outer catch (which would call release() on a completed record).
    try {
      await prismaAuditAdapter.recordCriticalWrite({
        businessId: result.id,
        actorUserId: actor.actorUserId,
        routeScope: ONBOARDING_COMPLETE_ACTION.routeScope,
        actionType: ONBOARDING_COMPLETE_ACTION.actionType,
        resourceType: ONBOARDING_COMPLETE_ACTION.resourceType,
        resourceId: result.id,
        summary: `Onboarding completado: ${normalizedBusinessName}`,
        payload: {
          businessId: result.id,
          businessName: normalizedBusinessName,
          productsCount: normalizedProducts.length,
          customersCount: customers?.length ?? 0,
          suppliersCount: suppliers?.length ?? 0,
        },
      });
    } catch (auditErr) {
      logRouteError("onboarding:audit_write", auditErr);
    }

    return NextResponse.json({ businessId: result.id }, { status: 201 });
  } catch (err) {
    // Reachable if initializeBusinessOnboardingState or seeding throws. The
    // business row may or may not exist; the idempotency record is still pending,
    // so release() is safe — the caller may retry and the upsert makes it idempotent.
    await prismaIdempotencyAdapter.release(idempotencyRecordId);
    logRouteError("onboarding", err);
    return NextResponse.json(
      { code: "ONBOARDING_FAILED", message: "No pudimos guardar la configuración inicial. Probá de nuevo." },
      { status: 500 }
    );
  }
}
