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
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { createEmployeeBodySchema, deleteEmployeeBodySchema } from "./employee-schema";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { createEmployeeUseCase } from "@/application/use-cases/create-employee.use-case";
import { revokeEmployeeUseCase } from "@/application/use-cases/revoke-employee.use-case";
import { prismaEmployeeRepository } from "@/infrastructure/persistence/prisma-employee.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";

const MUTATION_ACTIONS = {
  POST: "employee.create",
  DELETE: "employee.revoke",
} as const satisfies RouteMutationDeclaration;
const CREATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);
const REVOKE_ACTION = getServerActionMeta(MUTATION_ACTIONS.DELETE);

const employeePorts = { employee: prismaEmployeeRepository, idempotency: prismaIdempotencyAdapter, audit: prismaAuditAdapter };
const createEmployee = createEmployeeUseCase(employeePorts);
const revokeEmployee = revokeEmployeeUseCase(employeePorts);

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(resolvedCtx));
  if (rateLimited) return rateLimited;
  const { businessId, actorUserId } = resolvedCtx;

  const parsed = await parseZodBody(req, createEmployeeBodySchema);
  if (!parsed.ok) return parsed.response;

  const name = parsed.data.name.trim();
  if (!name) return badRequest("El nombre del empleado es requerido (1-60 caracteres).");
  const pin = parsed.data.pin.trim();
  if (!pin) return badRequest("El PIN debe ser numérico de 4 a 8 dígitos.");

  try {
    const result = await createEmployee.execute({
      businessId,
      actorUserId,
      name,
      pin,
      // Don't include the raw PIN in the request hash payload — hashing name+businessId
      // is enough for replay match and avoids plaintext PIN in log paths.
      idempotencyKey: getIdempotencyKey(req),
      requestBody: { name },
      actionMeta: CREATE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta el encabezado X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Esta clave de idempotencia ya se usó para otra solicitud.");
    if (result.outcome === "idempotency_in_flight") return conflict("Esta solicitud ya se está procesando. Esperá antes de reintentar.");
    if (result.outcome === "already_exists") return conflict(`Ya existe un empleado con el nombre "${result.name}".`);
    if (result.outcome !== "created") return internalError("No se pudo crear el empleado.");

    return NextResponse.json({ employee: result.employee }, { status: 201 });
  } catch (error) {
    logRouteError("employees.POST", error);
    return internalError("No se pudo crear el empleado.");
  }
}

export async function GET(req: NextRequest) {
  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(resolvedCtx));
  if (rateLimited) return rateLimited;
  const { businessId } = resolvedCtx;

  try {
    const employees = await prismaEmployeeRepository.list(businessId);
    return NextResponse.json({ employees });
  } catch (error) {
    logRouteError("employees.GET", error);
    return internalError("No se pudo cargar la lista de empleados.");
  }
}

export async function DELETE(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleDelete(req));
}

async function handleDelete(req: NextRequest) {
  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(resolvedCtx));
  if (rateLimited) return rateLimited;
  const { businessId, actorUserId } = resolvedCtx;

  const parsed = await parseZodBody(req, deleteEmployeeBodySchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await revokeEmployee.execute({
      businessId,
      actorUserId,
      employeeId: parsed.data.employeeId,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: { employeeId: parsed.data.employeeId },
      actionMeta: REVOKE_ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta el encabezado X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Esta clave de idempotencia ya se usó para otra solicitud.");
    if (result.outcome === "idempotency_in_flight") return conflict("Esta solicitud ya se está procesando. Esperá antes de reintentar.");
    if (result.outcome === "not_found") return notFound("No se encontró el empleado.");
    if (result.outcome !== "revoked") return internalError("No se pudo revocar el empleado.");

    // 204 No Content forbids a body.
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    logRouteError("employees.DELETE", error);
    return internalError("No se pudo revocar el empleado.");
  }
}
