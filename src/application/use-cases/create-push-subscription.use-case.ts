import type { PushSubscriptionRepositoryPort, PushSubscriptionRecord } from "@/domain/ports/push-subscription.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface CreatePushSubscriptionInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel: string | null;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type CreatePushSubscriptionResult =
  | { outcome: "subscribed"; subscription: PushSubscriptionRecord }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  pushSubscription: PushSubscriptionRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

export function createPushSubscriptionUseCase(ports: Ports) {
  return {
    async execute(input: CreatePushSubscriptionInput): Promise<CreatePushSubscriptionResult> {
      const { businessId, actorUserId, actorEmployeeId, endpoint, p256dh, auth, deviceLabel, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const subscription = await ports.transaction.run(async (tx) => {
          const sub = await ports.pushSubscription.upsertInTransaction(tx, { businessId, userId: actorUserId, endpoint, p256dh, auth, deviceLabel });
          await ports.idempotency.complete(tx, recordId, 200, { ok: true });
          return sub;
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: subscription.id,
          summary: deviceLabel ? `Suscripción push registrada (${deviceLabel})` : "Suscripción push registrada",
          payload: { endpointHash: endpoint.slice(0, 32), deviceLabel },
        });

        return { outcome: "subscribed", subscription };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
