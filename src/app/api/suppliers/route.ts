import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  bypassIfTester,
  checkRateLimit,
  conflict,
  internalError,
  logRouteError,
  notFound,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { supplierCreateSchema, supplierDeleteSchema, supplierUpdateSchema } from "./supplier-schema";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { normalizeInput } from "@/lib/normalize";
import { normalizeSupplierName } from "@/app/api/_lib/supplier-resolution";
import { toSupplierResponse } from "./_lib/suppliers-validation";
import { createSupplierUseCase } from "@/application/use-cases/create-supplier.use-case";
import { updateSupplierUseCase } from "@/application/use-cases/update-supplier.use-case";
import { deleteSupplierUseCase } from "@/application/use-cases/delete-supplier.use-case";
import { prismaSupplierRepository } from "@/infrastructure/persistence/prisma-supplier.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";

const MUTATION_ACTIONS = {
  POST: "supplier.create",
  PATCH: "supplier.update",
  DELETE: "supplier.delete",
} as const satisfies RouteMutationDeclaration;

const SUPPLIER_CREATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);
const SUPPLIER_UPDATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.PATCH);
const SUPPLIER_DELETE_ACTION = getServerActionMeta(MUTATION_ACTIONS.DELETE);

const adapters = {
  supplier: prismaSupplierRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
};

const createSupplier = createSupplierUseCase(adapters);
const updateSupplier = updateSupplierUseCase(adapters);
const deleteSupplier = deleteSupplierUseCase(adapters);

// ── GET /api/suppliers ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  try {
    const rows = await prisma.supplier.findMany({
      where: { businessId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, phone: true, email: true, contactName: true, leadTimeDays: true },
    });
    return NextResponse.json({ suppliers: rows.map(toSupplierResponse) });
  } catch (error) {
    logRouteError("suppliers/list", error);
    return internalError("No se pudo obtener la lista de proveedores.");
  }
}

// ── POST /api/suppliers ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = ctx;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  try {
    const parsed = await parseZodBody(req, supplierCreateSchema);
    if (!parsed.ok) return parsed.response;

    if (parsed.data.taxId !== undefined && normalizeInput(parsed.data.taxId)) {
      return badRequest("El CUIT/CUIL del proveedor todavía no está soportado.");
    }

    const name = normalizeSupplierName(parsed.data.name);
    if (!name) return badRequest("El nombre del proveedor es obligatorio.");

    const result = await createSupplier.execute({
      businessId,
      actorUserId,
      name,
      phone: parsed.data.phone ?? undefined,
      email: parsed.data.email ?? undefined,
      contactName: parsed.data.contactName ?? undefined,
      leadTimeDays: parsed.data.leadTimeDays,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: parsed.data,
      actionMeta: SUPPLIER_CREATE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "created") return internalError("No se pudo crear el proveedor.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ supplier: toSupplierResponse(result.supplier) }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "SUPPLIER_ALREADY_EXISTS") {
      return conflict("Ya existe un proveedor con ese nombre.");
    }
    logRouteError("suppliers/create", error);
    return internalError("No se pudo crear el proveedor.");
  }
}

// ── PATCH /api/suppliers ──────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePatch(req));
}

async function handlePatch(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = ctx;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  try {
    const parsed = await parseZodBody(req, supplierUpdateSchema);
    if (!parsed.ok) return parsed.response;

    if (parsed.data.taxId !== undefined && normalizeInput(parsed.data.taxId)) {
      return badRequest("El CUIT/CUIL del proveedor todavía no está soportado.");
    }

    const id = normalizeInput(parsed.data.id);
    if (!id) return badRequest("Falta el identificador del proveedor.");

    const hasAnyField =
      parsed.data.name !== undefined ||
      parsed.data.phone !== undefined ||
      parsed.data.email !== undefined ||
      parsed.data.contactName !== undefined ||
      parsed.data.leadTimeDays !== undefined;
    if (!hasAnyField) return badRequest("Hace falta al menos un campo para actualizar.");

    if (parsed.data.name !== undefined && !normalizeSupplierName(parsed.data.name)) {
      return badRequest("El nombre del proveedor no puede quedar vacío.");
    }

    const name = parsed.data.name !== undefined ? (normalizeSupplierName(parsed.data.name) ?? undefined) : undefined;

    const result = await updateSupplier.execute({
      businessId,
      actorUserId,
      supplierId: id,
      name,
      phone: parsed.data.phone,
      email: parsed.data.email,
      contactName: parsed.data.contactName,
      leadTimeDays: parsed.data.leadTimeDays,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: parsed.data,
      actionMeta: SUPPLIER_UPDATE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "updated") return internalError("No se pudo actualizar el proveedor.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "SUPPLIER_NOT_FOUND") return notFound("No se encontró el proveedor.");
      if (error.message === "SUPPLIER_ALREADY_EXISTS") return conflict("Ya existe un proveedor con ese nombre.");
    }
    logRouteError("suppliers/update", error);
    return internalError("No se pudo actualizar el proveedor.");
  }
}

// ── DELETE /api/suppliers ─────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleDelete(req));
}

async function handleDelete(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = ctx;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  try {
    const parsed = await parseZodBody(req, supplierDeleteSchema);
    if (!parsed.ok) return parsed.response;

    const id = normalizeInput(parsed.data.id);
    if (!id) return badRequest("Falta el identificador del proveedor.");

    const result = await deleteSupplier.execute({
      businessId,
      actorUserId,
      supplierId: id,
      idempotencyKey: getIdempotencyKey(req),
      actionMeta: SUPPLIER_DELETE_ACTION,
    });

    if (result.outcome === "not_found") return notFound("No se encontró el proveedor.");
    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "deleted") return internalError("No se pudo eliminar el proveedor.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logRouteError("suppliers/delete", error);
    return internalError("No se pudo eliminar el proveedor.");
  }
}
