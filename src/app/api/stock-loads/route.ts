import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  bypassIfTester,
  checkRateLimit,
  conflict,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { parseAndValidateStockLoadRequest } from "./_lib/stock-load-validation";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { createStockLoadUseCase } from "@/application/use-cases/create-stock-load.use-case";
import { prismaStockLoadRepository } from "@/infrastructure/persistence/prisma-stock-load.repository";
import { prismaStockLoadAuditAdapter } from "@/infrastructure/persistence/prisma-stock-load-audit.adapter";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import { enforcePolicy, policyDeniedResponse } from "@/app/api/_lib/policy-evaluator";
import { runWithTraceContext } from "@/lib/cloud-logger";

const MUTATION_ACTIONS = {
  POST: "stock-load.create",
} as const satisfies RouteMutationDeclaration;
const STOCK_LOAD_CREATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

const stockLoadUseCase = createStockLoadUseCase({
  stockLoad: prismaStockLoadRepository,
  stockLoadAudit: prismaStockLoadAuditAdapter,
  idempotency: prismaIdempotencyAdapter,
  transaction: prismaTransactionAdapter,
});

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  try {
    const validation = await parseAndValidateStockLoadRequest(req);
    if (!validation.ok) return validation.response;
    const { productId, itemName, supplierId, supplierName, quantity, unitPrice, createPurchaseRequest, autoCreateProduct } = validation.data;

    const totalCost = typeof unitPrice === "number" && typeof quantity === "number" ? quantity * unitPrice : null;
    const policyDecision = await enforcePolicy({
      businessId,
      actorId: actorEmployeeId ?? actorUserId,
      actorRole: ctx.role,
      action: { type: "stock-load", data: { quantity, unitPrice, totalCost } },
    });
    if (!policyDecision.allowed) return policyDeniedResponse(policyDecision);

    const result = await stockLoadUseCase.execute({
      businessId, actorUserId, actorEmployeeId,
      productId, itemName, supplierId, supplierName, quantity, unitPrice,
      createPurchaseRequest, autoCreateProduct,
      idempotencyKey: getIdempotencyKey(req),
      actionMeta: STOCK_LOAD_CREATE_ACTION,
      requestBody: { productId: productId || null, itemName: itemName || null, supplierId: supplierId || null, supplierName: supplierName || null, quantity, unitPrice, createPurchaseRequest },
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "demo_limit_reached") return NextResponse.json({ code: "DEMO_LIMIT_REACHED", message: result.message }, { status: 403 });
    if (result.outcome === "idempotency_missing") return badRequest("Falta el encabezado X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return badRequest("Esta clave de idempotencia ya se usó para otra solicitud.");
    if (result.outcome === "idempotency_in_flight") return badRequest("Esta solicitud ya se está procesando.");
    if (result.outcome === "business_not_found") return badRequest("No se encontró el negocio.");
    if (result.outcome === "product_not_found") return badRequest("No se encontró un producto válido para este negocio.");
    if (result.outcome === "supplier_not_found") return badRequest("No se encontró un proveedor válido para este negocio.");
    if (result.outcome === "product_not_found_auto_create_disabled") return badRequest("El producto no existe. Crealo primero desde Inventario.");
    if (result.outcome === "unit_price_required_for_new_product") return badRequest("Hace falta el costo unitario para crear un producto nuevo.");
    if (result.outcome === "product_sku_conflict") return conflict("No se pudo asignar un SKU único al producto. Probá de nuevo.");
    if (result.outcome === "purchase_request_item_required") return badRequest("Hace falta indicar el ítem para generar la solicitud de compra.");
    if (result.outcome === "purchase_request_quantity_invalid") return badRequest("La cantidad debe ser un número entero mayor a cero.");
    if (result.outcome === "purchase_request_unit_price_invalid") return badRequest("Hace falta el costo unitario para generar la solicitud de compra.");

    if (result.outcome !== "created") return internalError("No se pudo guardar la carga de stock.");
    invalidateBusinessContext(businessId);
    return NextResponse.json(result.data, { status: 201 });
  } catch (error) {
    logRouteError("stock-loads/post", error, { businessId, actionType: "stock-load.create" });
    return internalError("No se pudo guardar la carga de stock.");
  }
}
