import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  checkRateLimit,
  conflict,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { purchaseRequestCreateSchema } from "./purchase-request-schema";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { normalizeSupplierName } from "@/app/api/_lib/supplier-resolution";
import { normalizePurchaseRequestCreateInput } from "@/app/api/_lib/purchase-request-creation";
import { normalizeInput } from "@/lib/normalize";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { createPurchaseRequestUseCase } from "@/application/use-cases/create-purchase-request.use-case";
import { prismaPurchaseRequestRepository } from "@/infrastructure/persistence/prisma-purchase-request.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";

const MUTATION_ACTIONS = {
  POST: "purchase-request.create",
} as const satisfies RouteMutationDeclaration;
const PURCHASE_REQUEST_CREATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

const createPurchaseRequest = createPurchaseRequestUseCase({
  purchaseRequest: prismaPurchaseRequestRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

// ── GET /api/purchase-requests ────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = resolvedCtx;

  try {
    const requests = await prismaPurchaseRequestRepository.list(businessId);
    return NextResponse.json({ requests });
  } catch (error) {
    logRouteError("purchase-requests/list", error);
    return internalError("No se pudieron obtener las solicitudes de compra.");
  }
}

// ── POST /api/purchase-requests ───────────────────────────────────────────

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  try {
    const parsed = await parseZodBody(req, purchaseRequestCreateSchema);
    if (!parsed.ok) return parsed.response;

    const supplierId = normalizeInput(parsed.data.supplierId);
    const supplierName = normalizeSupplierName(parsed.data.supplierName);
    if (!supplierId && !supplierName) return badRequest("Hace falta indicar un proveedor.");

    const purchaseRequestInput = normalizePurchaseRequestCreateInput({
      itemName: parsed.data.itemName,
      quantity: parsed.data.quantity,
      unitPrice: parsed.data.unitPrice,
    });

    const result = await createPurchaseRequest.execute({
      businessId,
      actorUserId,
      actorEmployeeId,
      supplierId: supplierId || null,
      supplierName: supplierName || null,
      itemName: purchaseRequestInput.itemName,
      quantity: purchaseRequestInput.quantity,
      unitPrice: purchaseRequestInput.unitPrice,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: {
        supplierId: supplierId || null,
        supplierName: supplierName || null,
        itemName: purchaseRequestInput.itemName,
        quantity: purchaseRequestInput.quantity,
        unitPrice: purchaseRequestInput.unitPrice,
      },
      actionMeta: PURCHASE_REQUEST_CREATE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "created") return internalError("No se pudo crear la solicitud de compra.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ request: result.request }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "PURCHASE_REQUEST_ITEM_REQUIRED")
      return badRequest("Hace falta indicar el ítem.");
    if (error instanceof Error && error.message === "PURCHASE_REQUEST_QUANTITY_INVALID")
      return badRequest("La cantidad debe ser un número entero mayor a cero.");
    if (error instanceof Error && error.message === "PURCHASE_REQUEST_UNIT_PRICE_INVALID")
      return badRequest("El precio unitario debe ser un número válido mayor o igual a cero.");
    if (error instanceof Error && error.message === "SUPPLIER_NOT_FOUND")
      return badRequest("Proveedor inválido para este negocio.");
    if (error instanceof Error && error.message === "SUPPLIER_REQUIRED")
      return badRequest("No se encontró el proveedor.");
    if (error instanceof Error && error.message === "BUSINESS_NOT_FOUND")
      return badRequest("No se encontró el negocio.");
    logRouteError("purchase-requests", error, {
      businessId,
      actionType: PURCHASE_REQUEST_CREATE_ACTION.actionType,
    });
    return internalError("No se pudo crear la solicitud de compra.");
  }
}
