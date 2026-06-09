import type { EmployeeRepositoryPort } from "@/domain/ports/employee.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";

export interface RevokeEmployeeInput {
  businessId: string;
  actorUserId: string;
  employeeId: string;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type RevokeEmployeeResult =
  | { outcome: "revoked"; employee: { id: string; name: string } }
  | { outcome: "not_found" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  employee: EmployeeRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
}

export function revokeEmployeeUseCase(ports: Ports) {
  return {
    async execute(input: RevokeEmployeeInput): Promise<RevokeEmployeeResult> {
      const { businessId, actorUserId, employeeId, idempotencyKey, requestBody, actionMeta } = input;

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

      const employee = await ports.employee.findById(businessId, employeeId);
      if (!employee) {
        await ports.idempotency.release(recordId);
        return { outcome: "not_found" };
      }

      try {
        await ports.employee.revoke(businessId, employeeId);
      } catch (err) {
        await ports.idempotency.release(recordId);
        throw err;
      }

      // 204 No Content — record empty body so replays parse cleanly.
      await ports.idempotency.complete(null, recordId, 204, {});

      try {
        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: employee.id,
          summary: `Revocó empleado "${employee.name}"`,
          payload: { employeeId: employee.id, name: employee.name, previousRole: employee.role },
        });
      } catch { /* audit gap — employee revoked, absorb audit failure */ }

      return { outcome: "revoked", employee: { id: employee.id, name: employee.name } };
    },
  };
}
