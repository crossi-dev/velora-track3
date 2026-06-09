import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  conflict,
  internalError,
  logRouteError,
  notFound,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { deleteProductBodySchema } from "@/app/api/products/product-schema";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { isProductSkuCollision } from "@/infrastructure/shared/product-sku";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { fetchProducts } from "@/app/api/products/_get";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { validatePostBody, validatePatchBody } from "@/app/api/products/_validate";
import { createProductUseCase } from "@/application/use-cases/create-product.use-case";
import { updateProductUseCase } from "@/application/use-cases/update-product.use-case";
import { deleteProductUseCase } from "@/application/use-cases/delete-product.use-case";
import { prismaProductRepository } from "@/infrastructure/persistence/prisma-product.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";

const MUTATION_ACTIONS = {
  POST: "product.create",
  PATCH: "product.update",
  DELETE: "product.delete",
} as const satisfies RouteMutationDeclaration;
const PRODUCT_CREATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);
const PRODUCT_UPDATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.PATCH);
const PRODUCT_DELETE_ACTION = getServerActionMeta(MUTATION_ACTIONS.DELETE);
const STOCK_ADJUST_ACTION_TYPE = "stock.adjust";

const adapters = {
  product: prismaProductRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
};

const createProduct = createProductUseCase({ product: adapters.product, idempotency: adapters.idempotency, audit: adapters.audit });
const updateProduct = updateProductUseCase(adapters);
const deleteProduct = deleteProductUseCase(adapters);

// ── GET /api/products ─────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  return fetchProducts(ctx.businessId);
}

// ── POST /api/products ────────────────────────────────────────────────────

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
    const validated = await validatePostBody(req);
    if (!validated.ok) return validated.response;

    const { normalizedName, numericPrice, numericStock, stockReason, stockReferenceId, costPrice, weightGrams } = validated.data;

    const result = await createProduct.execute({
      businessId,
      actorUserId,
      actorEmployeeId,
      name: normalizedName,
      price: numericPrice,
      costPrice: costPrice ?? null,
      weightGrams: weightGrams ?? null,
      initialStock: numericStock,
      stockReason,
      stockReferenceId,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: validated.data.rawData,
      actionMeta: PRODUCT_CREATE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return internalError("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return internalError("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return internalError("Operación en curso.");
    if (result.outcome !== "created") return internalError("No se pudo crear el producto.");

    const p = result.product;
    invalidateBusinessContext(businessId);
    return NextResponse.json({ product: { id: p.id, name: p.name, price: p.price, costPrice: p.costPrice, sku: p.sku, stock: p.stock, weightGrams: p.weightGrams ?? null } }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "PRODUCT_SKU_CONFLICT") {
      return conflict("No se pudo asignar un SKU único. Probá de nuevo.");
    }
    logRouteError("products/post", error);
    return internalError("No se pudo crear el producto.");
  }
}

// ── PATCH /api/products ───────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePatch(req));
}

async function handlePatch(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  try {
    const validated = await validatePatchBody(req);
    if (!validated.ok) return validated.response;

    const { id, sku, weightGrams, stockReason, stockReferenceId, isStockOnlyAdjustment, productUpdateData, stockQuantity } = validated.data;

    const patchActionType = isStockOnlyAdjustment ? STOCK_ADJUST_ACTION_TYPE : PRODUCT_UPDATE_ACTION.actionType;
    const patchActionMeta = {
      actionType: patchActionType,
      routeScope: PRODUCT_UPDATE_ACTION.routeScope,
      resourceType: PRODUCT_UPDATE_ACTION.resourceType,
    };

    const result = await updateProduct.execute({
      businessId,
      actorUserId,
      actorEmployeeId,
      productId: id,
      name: productUpdateData.name,
      price: productUpdateData.price,
      costPrice: productUpdateData.costPrice,
      sku: typeof sku === "string" || sku === null ? sku : undefined,
      weightGrams,
      stockQuantity,
      stockReason,
      stockReferenceId,
      productUpdateData,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: validated.data.rawData,
      actionMeta: patchActionMeta,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return internalError("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return internalError("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return internalError("Operación en curso.");
    if (result.outcome !== "updated") return internalError("No se pudo actualizar el producto.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "PRODUCT_NOT_FOUND") {
      return notFound("No se encontró el producto.");
    }
    if (isProductSkuCollision(error)) {
      return conflict("Ese SKU ya existe en este negocio.");
    }
    logRouteError("products/patch", error);
    return internalError("No se pudo actualizar el producto.");
  }
}

// ── DELETE /api/products ──────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleDelete(req));
}

async function handleDelete(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  try {
    const parsed = await parseZodBody(req, deleteProductBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await deleteProduct.execute({
      businessId,
      actorUserId,
      actorEmployeeId,
      productId: parsed.data.id.trim(),
      idempotencyKey: getIdempotencyKey(req),
      actionMeta: PRODUCT_DELETE_ACTION,
    });

    if (result.outcome === "not_found") return notFound("No se encontró el producto.");
    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return internalError("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return internalError("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return internalError("Operación en curso.");
    if (result.outcome !== "deleted") return internalError("No se pudo eliminar el producto.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ ok: true, archived: result.archived });
  } catch (error) {
    logRouteError("products/delete", error);
    return internalError("No se pudo eliminar el producto.");
  }
}
