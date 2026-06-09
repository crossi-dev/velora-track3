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
import { resolveOrCreateBodySchema } from "./resolve-or-create-schema";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { normalizeProductName, parseProductNonNegativeNumber } from "@/infrastructure/shared/product-mutations";
import { normalizeLookupText } from "@/lib/shared-utils";
import { resolveOrCreateProductUseCase } from "@/application/use-cases/resolve-or-create-product.use-case";
import { prismaProductRepository } from "@/infrastructure/persistence/prisma-product.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";

const MUTATION_ACTIONS = {
  POST: "product.resolve-or-create",
} as const satisfies RouteMutationDeclaration;
const ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

const resolveOrCreateUseCase = resolveOrCreateProductUseCase({
  product: prismaProductRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
});

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  const parsed = await parseZodBody(req, resolveOrCreateBodySchema);
  if (!parsed.ok) return parsed.response;

  const normalizedName = normalizeProductName(parsed.data.name);
  if (!normalizedName) return badRequest("El nombre es obligatorio.");

  const numericPrice = parseProductNonNegativeNumber(parsed.data.price);
  if (numericPrice === null) return badRequest("El precio debe ser un número mayor o igual a cero.");

  let resolvedCostPrice: number | null | undefined;
  if (parsed.data.costPrice === undefined) {
    resolvedCostPrice = undefined;
  } else if (parsed.data.costPrice === null) {
    resolvedCostPrice = null;
  } else {
    const cp = parseProductNonNegativeNumber(parsed.data.costPrice);
    if (cp === null) return badRequest("El costo debe ser un número mayor o igual a cero o vacío.");
    resolvedCostPrice = cp;
  }

  try {
    const result = await resolveOrCreateUseCase.execute({
      businessId, actorUserId, actorEmployeeId,
      productName: normalizedName,
      normalizedName: normalizeLookupText(normalizedName),
      price: numericPrice,
      costPrice: resolvedCostPrice,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: parsed.data,
      actionMeta: ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return internalError("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return internalError("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return internalError("Operación en curso.");
    if (result.outcome === "sku_collision") return conflict("No se pudo asignar un SKU único. Probá de nuevo.");
    if (result.outcome === "resolved") return NextResponse.json({ resolved: true, product: result.product }, { status: 200 });
    if (result.outcome === "created") return NextResponse.json({ resolved: false, product: result.product }, { status: 201 });
    return internalError("No se pudo resolver el producto.");
  } catch (error) {
    logRouteError("products/resolve-or-create", error);
    return internalError("No se pudo resolver el producto.");
  }
}
