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
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { createCustomerBodySchema, updateCustomerBodySchema, deleteCustomerBodySchema } from "./customer-schema";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { createCustomerUseCase } from "@/application/use-cases/create-customer.use-case";
import { updateCustomerUseCase } from "@/application/use-cases/update-customer.use-case";
import { deleteCustomerUseCase } from "@/application/use-cases/delete-customer.use-case";
import { prismaCustomerRepository } from "@/infrastructure/persistence/prisma-customer.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";

const MUTATION_ACTIONS = {
  POST: "customer.create",
  PATCH: "customer.update",
  DELETE: "customer.delete",
} as const satisfies RouteMutationDeclaration;
const CUSTOMER_CREATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);
const CUSTOMER_UPDATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.PATCH);
const CUSTOMER_DELETE_ACTION = getServerActionMeta(MUTATION_ACTIONS.DELETE);

const adapters = {
  customer: prismaCustomerRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
};

const createCustomer = createCustomerUseCase(adapters);
const updateCustomer = updateCustomerUseCase(adapters);
const deleteCustomer = deleteCustomerUseCase(adapters);

// ── GET /api/customers?id=<customerId> ───────────────────────────────────
// Returns a single customer by id. Logs a read-event to CriticalWriteEvent for
// compliance (who viewed which customer's PII).

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  // Actionable 403: employee gets a message pointing them to the chat flow
  // instead of a generic "Insufficient permissions." that leaves them stuck.
  if (ctx.role !== "owner") {
    return NextResponse.json(
      {
        code: "FORBIDDEN_ROLE",
        message: "Solo el dueño puede ver la lista de clientes. Si necesitás registrar una venta a un cliente nuevo, decímelo en el chat.",
      },
      { status: 403 },
    );
  }
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  const customerId = req.nextUrl.searchParams.get("id")?.trim();
  if (!customerId) return badRequest("Falta el parámetro id.");

  try {
    const customer = await prismaCustomerRepository.findById(businessId, customerId);
    if (!customer) return notFound("No se encontró el cliente.");

    void recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId,
      actorEmployeeId,
      actionType: "customer.read",
      resourceType: "Customer",
      resourceId: customerId,
      routeScope: "customers/detail",
      summary: `Cliente consultado: ${customerId}`,
      payload: { customerId },
      input: { customerId },
      after: { id: customer.id },
    });

    return NextResponse.json({ customer });
  } catch (error) {
    logRouteError("customers/get", error);
    return internalError("No se pudo obtener el cliente.");
  }
}

// ── POST /api/customers ───────────────────────────────────────────────────

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
  const { businessId, actorUserId } = ctx;

  try {
    const parsed = await parseZodBody(req, createCustomerBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await createCustomer.execute({
      businessId,
      actorUserId,
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email,
      taxId: parsed.data.taxId,
      dni: parsed.data.dni,
      ivaCondition: parsed.data.ivaCondition,
      address: parsed.data.address,
      postalCode: parsed.data.postalCode,
      city: parsed.data.city,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: parsed.data,
      actionMeta: CUSTOMER_CREATE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "created") return internalError("No se pudo crear el cliente.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ customer: result.customer }, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "CUSTOMER_NAME_REQUIRED") return badRequest("El nombre es obligatorio.");
      if (error.message === "CUSTOMER_ALREADY_EXISTS") return conflict("Ya existe un cliente con ese nombre.");
    }
    logRouteError("customers/create", error);
    return internalError("No se pudo crear el cliente.");
  }
}

// ── PATCH /api/customers ──────────────────────────────────────────────────

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
  const { businessId, actorUserId } = ctx;

  try {
    const parsed = await parseZodBody(req, updateCustomerBodySchema);
    if (!parsed.ok) return parsed.response;

    const id = parsed.data.id.trim();
    if (!id) return badRequest("Hace falta el identificador del cliente.");

    const hasAnyField =
      parsed.data.name !== undefined ||
      parsed.data.phone !== undefined ||
      parsed.data.email !== undefined ||
      parsed.data.taxId !== undefined ||
      parsed.data.dni !== undefined ||
      parsed.data.ivaCondition !== undefined ||
      parsed.data.address !== undefined ||
      parsed.data.postalCode !== undefined ||
      parsed.data.city !== undefined;
    if (!hasAnyField) return badRequest("Hace falta al menos un campo para actualizar.");

    const result = await updateCustomer.execute({
      businessId,
      actorUserId,
      customerId: id,
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email,
      taxId: parsed.data.taxId,
      dni: parsed.data.dni,
      ivaCondition: parsed.data.ivaCondition,
      address: parsed.data.address,
      postalCode: parsed.data.postalCode,
      city: parsed.data.city,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: parsed.data,
      actionMeta: CUSTOMER_UPDATE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "updated") return internalError("No se pudo actualizar el cliente.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "CUSTOMER_NOT_FOUND") return notFound("No se encontró el cliente.");
      if (error.message === "CUSTOMER_NAME_REQUIRED") return badRequest("El nombre no puede quedar vacío.");
      if (error.message === "CUSTOMER_ALREADY_EXISTS") return conflict("Ya existe un cliente con ese nombre.");
    }
    logRouteError("customers/update", error);
    return internalError("No se pudo actualizar el cliente.");
  }
}

// ── DELETE /api/customers ─────────────────────────────────────────────────

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
  const { businessId, actorUserId } = ctx;

  try {
    const parsed = await parseZodBody(req, deleteCustomerBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await deleteCustomer.execute({
      businessId,
      actorUserId,
      customerId: parsed.data.id.trim(),
      idempotencyKey: getIdempotencyKey(req),
      actionMeta: CUSTOMER_DELETE_ACTION,
    });

    if (result.outcome === "not_found") return notFound("No se encontró el cliente.");
    if (result.outcome === "has_history") {
      return NextResponse.json(
        {
          code: "HAS_HISTORY",
          message: `Este cliente tiene ${result.invoiceCount} factura${result.invoiceCount !== 1 ? "s" : ""} y ${result.saleCount} venta${result.saleCount !== 1 ? "s" : ""} históricas. Para preservar el historial, anonimizá los datos en lugar de eliminar.`,
          invoiceCount: result.invoiceCount,
          saleCount: result.saleCount,
        },
        { status: 409 },
      );
    }
    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "deleted") return internalError("No se pudo eliminar el cliente.");

    invalidateBusinessContext(businessId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    logRouteError("customers/delete", error);
    return internalError("No se pudo eliminar el cliente.");
  }
}
