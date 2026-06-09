import { hashPin } from "@/lib/employee-auth";
import type { EmployeeRepositoryPort, EmployeeRecord } from "@/domain/ports/employee.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";

function isUniqueNameConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code !== "P2002") return false;
  const meta = (error as { meta?: { target?: unknown } }).meta;
  const target = meta?.target;
  if (Array.isArray(target)) return target.some((f) => String(f).includes("name"));
  if (typeof target === "string") return target.includes("name");
  return error instanceof Error && /name/i.test(error.message) && /unique/i.test(error.message);
}

export interface CreateEmployeeInput {
  businessId: string;
  actorUserId: string;
  name: string;
  pin: string;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type CreateEmployeeResult =
  | { outcome: "created"; employee: EmployeeRecord }
  | { outcome: "already_exists"; name: string }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  employee: EmployeeRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
}

export function createEmployeeUseCase(ports: Ports) {
  return {
    async execute(input: CreateEmployeeInput): Promise<CreateEmployeeResult> {
      const { businessId, actorUserId, name, pin, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({
        businessId,
        actionType: actionMeta.actionType,
        idempotencyKey,
        requestBody,
      });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      const existing = await ports.employee.findByName(businessId, name);
      if (existing) {
        await ports.idempotency.release(recordId);
        return { outcome: "already_exists", name };
      }

      const pinHash = hashPin(pin);
      let employee: EmployeeRecord;
      try {
        employee = await ports.employee.create({ businessId, name, pinHash, role: "employee" });
      } catch (err) {
        // Two concurrent creates raced past findByName — the DB unique constraint
        // on (businessId, name) fires P2002; surface it as already_exists instead
        // of an unhandled 500.
        if (isUniqueNameConstraintError(err)) {
          await ports.idempotency.release(recordId);
          return { outcome: "already_exists", name };
        }
        await ports.idempotency.release(recordId);
        throw err;
      }

      const responseBody = { employee };
      await ports.idempotency.complete(null, recordId, 201, responseBody);

      try {
        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: employee.id,
          summary: `Creó empleado "${name}" con rol employee`,
          payload: { employeeId: employee.id, name, role: "employee" },
        });
      } catch { /* audit gap — employee created, absorb audit failure */ }

      return { outcome: "created", employee };
    },
  };
}
