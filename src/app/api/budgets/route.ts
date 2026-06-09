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
import { createBudgetBodySchema, deleteBudgetBodySchema } from "./budget-schema";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { createBudgetUseCase } from "@/application/use-cases/create-budget.use-case";
import { deleteBudgetUseCase } from "@/application/use-cases/delete-budget.use-case";
import { prismaBudgetRepository } from "@/infrastructure/persistence/prisma-budget.repository";
import { prismaBusinessRepository } from "@/infrastructure/persistence/prisma-business.repository";
import { prismaCustomerRepository } from "@/infrastructure/persistence/prisma-customer.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";

const MUTATION_ACTIONS = {
  POST: "budget.create",
  DELETE: "budget.delete",
} as const satisfies RouteMutationDeclaration;
const BUDGET_CREATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);
const BUDGET_DELETE_ACTION = getServerActionMeta(MUTATION_ACTIONS.DELETE);

const adapters = {
  budget: prismaBudgetRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
};

const createBudget = createBudgetUseCase(adapters);
const deleteBudget = deleteBudgetUseCase(adapters);

// ── GET /api/budgets ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(resolvedCtx));
  if (rateLimited) return rateLimited;
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = resolvedCtx;

  try {
    const budgets = await prismaBudgetRepository.list(businessId);
    return NextResponse.json({ budgets });
  } catch (error) {
    logRouteError("budgets/list", error);
    return internalError("No se pudieron obtener los presupuestos.");
  }
}

// ── POST /api/budgets ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = resolvedCtx;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(resolvedCtx));
  if (rateLimited) return rateLimited;

  try {
    const parsed = await parseZodBody(req, createBudgetBodySchema);
    if (!parsed.ok) return parsed.response;

    const { customerName, customerId: rawCustomerId, note, items } = parsed.data;

    const business = await prismaBusinessRepository.findCurrency(businessId);
    if (!business) return internalError("No se encontró el negocio.");

    const trimmedCustomerName = customerName?.trim() || null;
    let resolvedCustomerId: string | null = rawCustomerId?.trim() || null;
    if (!resolvedCustomerId && trimmedCustomerName) {
      const found = await prismaCustomerRepository.findByName(businessId, trimmedCustomerName);
      resolvedCustomerId = found?.id ?? null;
    }

    const totalAmount = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

    const result = await createBudget.execute({
      businessId,
      actorUserId,
      currency: business.currency,
      customerName: trimmedCustomerName,
      customerId: resolvedCustomerId,
      note: note?.trim() || null,
      totalAmount,
      items: items.map((item) => ({
        productId: item.productId || null,
        name: item.name.trim(),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      idempotencyKey: getIdempotencyKey(req),
      requestBody: {
        customerName: trimmedCustomerName,
        note: note?.trim() || null,
        items: items.map((item) => ({
          productId: item.productId || null,
          name: item.name.trim(),
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      },
      actionMeta: BUDGET_CREATE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "created") return internalError("No se pudo crear el presupuesto.");

    return NextResponse.json({ budget: result.budget }, { status: 201 });
  } catch (error) {
    logRouteError("budgets/create", error);
    return internalError("No se pudo crear el presupuesto.");
  }
}

// ── DELETE /api/budgets ───────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleDelete(req));
}

async function handleDelete(req: NextRequest) {
  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = resolvedCtx;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(resolvedCtx));
  if (rateLimited) return rateLimited;

  try {
    const parsed = await parseZodBody(req, deleteBudgetBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await deleteBudget.execute({
      businessId,
      actorUserId,
      budgetId: parsed.data.budgetId.trim(),
      idempotencyKey: getIdempotencyKey(req),
      actionMeta: BUDGET_DELETE_ACTION,
    });

    if (result.outcome === "not_found") return notFound("No se encontró el presupuesto.");
    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "deleted") return internalError("No se pudo eliminar el presupuesto.");

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    logRouteError("budgets/delete", error);
    return internalError("No se pudo eliminar el presupuesto.");
  }
}
