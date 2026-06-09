import type { CashMovementRepositoryPort, CashMovementType } from "@/domain/ports/cash-movement.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import { assertDemoQuota, incrementDemoActionInTx, DemoLimitReachedError } from "@/app/api/_lib/demo-quota";

export interface CreateCashMovementInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  type: CashMovementType;
  description: string;
  amount: number;
  date: Date;
  idempotencyKey: string;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
  requestBody: unknown;
  // X-Idempotency-Key forwarded to the DB row so the partial unique index
  // CashMovement_businessId_clientMessageId_key enforces dedup at DB level —
  // guards against retries from different clients or cold-start IdempotencyRecord races.
  clientMessageId?: string | null;
}

export type CreateCashMovementResult =
  | { outcome: "created"; movement: { id: string; type: string; description: string; amount: number; date: Date }; signCorrected: boolean }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" }
  | { outcome: "demo_limit_reached"; message: string };

interface Ports {
  cashMovements: CashMovementRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

export function createCashMovementUseCase(ports: Ports) {
  return {
    async execute(input: CreateCashMovementInput): Promise<CreateCashMovementResult> {
      const { businessId, actorUserId, actorEmployeeId, type, description, amount, date, idempotencyKey, actionMeta, requestBody, clientMessageId } = input;

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

      // Quota checked after begin so replays of already-counted actions are never blocked.
      try {
        await assertDemoQuota(businessId);
      } catch (e) {
        if (e instanceof DemoLimitReachedError) {
          await ports.idempotency.release(recordId);
          return { outcome: "demo_limit_reached", message: e.message };
        }
        throw e;
      }

      try {
        const { movement, signCorrected } = await ports.transaction.run(async (tx) => {
          const created = await ports.cashMovements.createInTransaction(tx, { businessId, type, description, amount, date, clientMessageId: clientMessageId ?? null });
          const storedAmount = Number(created.amount);
          const corrected = Math.sign(storedAmount) !== Math.sign(amount);
          const body = {
            movement: { id: created.id, type: created.type, description: created.description, amount: storedAmount, date: created.date },
            ...(corrected ? { signCorrected: true } : {}),
          };
          await incrementDemoActionInTx(tx, businessId);
          await ports.idempotency.complete(tx, recordId, 201, body);
          return { movement: body.movement, signCorrected: corrected };
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: movement.id,
          summary: `Movimiento de caja registrado: ${description}`,
          payload: { movementId: movement.id, type, amount, date: date.toISOString(), description },
          input: { type, description, amount, date: date.toISOString() },
          after: { movementId: movement.id, amount: movement.amount },
        });

        return { outcome: "created", movement, signCorrected };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
