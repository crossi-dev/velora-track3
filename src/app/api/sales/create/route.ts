import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, logRouteError, bypassIfTester } from "@/app/api/_lib/route-helpers";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { createMutationTrace } from "@/app/api/_lib/mutation-trace";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { createSaleBodySchema } from "./sale-schema";
import { type SaleItem, type CreateSaleBody, validateItemShapes } from "@/infrastructure/shared/sale-validation";
import { sumLineItems } from "@/lib/money";
import { validateSaleItems, validateSaleTotal } from "@/domain/rules";
import { normalizeCustomerName, CONSUMIDOR_FINAL_NAME } from "@/infrastructure/shared/sale-customer";
import { firePostCommitActions } from "./sale-post-commit";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { runWithTenantContext } from "@/lib/tenant-context";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { createSaleUseCase } from "@/application/use-cases/create-sale.use-case";
import { enforcePolicy, policyDeniedResponse } from "@/app/api/_lib/policy-evaluator";
import { prismaBusinessRepository } from "@/infrastructure/persistence/prisma-business.repository";
import { prismaSaleRepository } from "@/infrastructure/persistence/prisma-sale.repository";
import { prismaInventoryRepository } from "@/infrastructure/persistence/prisma-inventory.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";

const MUTATION_ACTIONS = {
  POST: "sale.create",
} as const satisfies RouteMutationDeclaration;
const SALE_CREATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

export type { SaleItem, CreateSaleBody };

const saleUseCase = createSaleUseCase({
  business: prismaBusinessRepository,
  sale: prismaSaleRepository,
  inventory: prismaInventoryRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  // EMPLOYEE_ALLOWED: ventas mixto owner+empleado (mutation-contract: sale.create).
  // El empleado en caja registra la venta; el dueño también puede.
  // Defense in depth: enforcePolicy() gatea DelegationPolicy y
  // no_sale_without_customer. No se agrega requireRole owner-only acá.

  const trace = createMutationTrace("sale.create");

  // RLS-1: bind businessId as tenant context for the duration of this request.
  // Inert until RLS_SESSION_CONTEXT_ENABLED=true — zero behavior change on deploy.
  try {
    return await runWithTenantContext(ctx.businessId, async () => {
    const parsedBody = await parseZodBody(req, createSaleBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const { customerId: rawCustomerId, items, total, locale, defaultCustomerName, paymentMethod, skipAutoWhatsapp } = parsedBody.data;
    const customerId = typeof rawCustomerId === "string" && rawCustomerId.trim() ? rawCustomerId.trim() : null;

    if (!Array.isArray(items)) return NextResponse.json({ code: "INVALID_ITEMS", message: "At least one item is required." }, { status: 400 });
    if (validateSaleItems(items)) return NextResponse.json({ code: "INVALID_ITEMS", message: "At least one item is required." }, { status: 400 });
    if (items.length > 500) return NextResponse.json({ code: "TOO_MANY_ITEMS", message: "Sale cannot exceed 500 items." }, { status: 400 });
    if (validateSaleTotal(Number(total))) return NextResponse.json({ code: "INVALID_TOTAL", message: "Sale total must be greater than zero." }, { status: 400 });
    const itemShapeError = validateItemShapes(items as SaleItem[]);
    if (itemShapeError) return NextResponse.json({ code: "INVALID_ITEM_SHAPE", message: itemShapeError }, { status: 400 });

    // sumLineItems uses Prisma.Decimal (decimal.js) — exact ROUND_HALF_UP, no float drift.
    // toNumber() only at the JSON comparison boundary.
    const clientTotal = sumLineItems(items as SaleItem[]).toNumber();
    if (Math.abs(clientTotal - Number(total)) > 0.05) return NextResponse.json({ code: "TOTAL_MISMATCH", message: "Sale total does not match the sum of items." }, { status: 400 });

    const fallbackCustomerName = (typeof defaultCustomerName === "string" && defaultCustomerName.trim()) ? defaultCustomerName.trim() : CONSUMIDOR_FINAL_NAME;
    const normalizedFallbackCustomerName = normalizeCustomerName(fallbackCustomerName);

    const policyDecision = await enforcePolicy({
      businessId: ctx.businessId,
      actorId: ctx.actorEmployeeId ?? ctx.actorUserId,
      actorRole: ctx.role,
      action: {
        type: "sale.create",
        data: {
          customerId,
          total: clientTotal,
        },
      },
    });
    if (!policyDecision.allowed) return policyDeniedResponse(policyDecision);

    const result = await saleUseCase.execute({
      businessId: ctx.businessId, actorUserId: ctx.actorUserId, actorEmployeeId: ctx.actorEmployeeId, actorRole: ctx.role,
      customerId, items: items as SaleItem[], fallbackCustomerName, normalizedFallbackCustomerName,
      idempotencyKey: getIdempotencyKey(req), actionMeta: SALE_CREATE_ACTION,
      requestBody: { customerId, locale: locale ?? null, items: (items as SaleItem[]).map(i => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice })), total: clientTotal, paymentMethod: paymentMethod ?? "efectivo" },
      paymentMethod: paymentMethod ?? "efectivo",
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "demo_limit_reached") return NextResponse.json({ code: "DEMO_LIMIT_REACHED", message: result.message }, { status: 403 });
    if (result.outcome === "idempotency_missing") return NextResponse.json({ code: "IDEMPOTENCY_MISSING", message: "Falta X-Idempotency-Key." }, { status: 400 });
    if (result.outcome === "idempotency_conflict") return NextResponse.json({ code: "IDEMPOTENCY_CONFLICT", message: "Conflicto de idempotencia." }, { status: 409 });
    if (result.outcome === "idempotency_in_flight") return NextResponse.json({ code: "IDEMPOTENCY_IN_FLIGHT", message: "Operación en curso." }, { status: 409 });
    if (result.outcome === "business_not_found") return NextResponse.json({ code: "BUSINESS_NOT_FOUND", message: "Business not found." }, { status: 404 });
    if (result.outcome === "sale_date_future") return NextResponse.json({ code: "SALE_DATE_FUTURE", message: "Sale date cannot be more than 1 minute in the future." }, { status: 422 });
    if (result.outcome === "entity_deleted") return NextResponse.json({ code: "ENTITY_DELETED", message: "One or more referenced entities have been deleted.", missing: result.missing }, { status: 422 });
    if (result.outcome === "customer_not_found") return NextResponse.json({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found." }, { status: 404 });
    if (result.outcome === "invalid_item_quantity") return NextResponse.json({ code: "INVALID_ITEM_QUANTITY", message: "Each item quantity must be greater than zero." }, { status: 400 });
    if (result.outcome === "product_not_owned") {
      cloudLog({ severity: "WARNING", component: "RBAC", action: "CROSS_TENANT_ID_REJECTED", a2a_transfer: false, message: "Cross-tenant product id rejected during sale create", data: { kind: "product", endpoint: "/api/sales/create" }, businessId: ctx.businessId, actorUserId: ctx.actorUserId, actorEmployeeId: ctx.actorEmployeeId ?? undefined });
      return NextResponse.json({ code: "PRODUCT_NOT_OWNED", message: "Product does not belong to this business." }, { status: 400 });
    }
    if (result.outcome === "insufficient_stock") return NextResponse.json({ code: "INSUFFICIENT_STOCK", message: `Insufficient stock for ${result.productName}. Available: ${result.available}.` }, { status: 400 });
    if (result.outcome === "price_outlier") return NextResponse.json({ code: "PRICE_OUTLIER", message: `El precio ingresado está ${result.direction === "above" ? "por encima" : "por debajo"} del precio de catálogo (esperado: $${result.expected}).` }, { status: 400 });
    if (result.outcome !== "created") return NextResponse.json({ code: "SALE_CREATE_FAILED", message: "Failed to create sale." }, { status: 500 });

    const { data } = result;
    const responseBody = { sale: { id: data.sale.id, totalAmount: data.sale.totalAmount, status: data.sale.status }, invoice: data.invoice, ...trace.toResponse() };

    firePostCommitActions({ businessId: ctx.businessId, actorEmployeeId: ctx.actorEmployeeId, saleId: data.sale.id, invoiceId: data.invoice.id, invoicePayload: data.invoice.payload as InvoicePayload, whatsappPhone: data.whatsappPhone, notifyLowStockWa: data.notifyLowStockWa, lowStockAlerts: data.lowStockAlerts, skipAutoWhatsapp, paymentMethod: paymentMethod ?? null });
    invalidateBusinessContext(ctx.businessId);
    return NextResponse.json(responseBody, { status: 201 });
    }); // end runWithTenantContext
  } catch (error) {
    logRouteError("sales/create", error, { businessId: ctx.businessId, actionType: SALE_CREATE_ACTION.actionType });
    return NextResponse.json({ code: "SALE_CREATE_FAILED", message: "Failed to create sale." }, { status: 500 });
  }
}
