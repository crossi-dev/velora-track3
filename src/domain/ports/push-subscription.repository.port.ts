import type { Tx } from "./tx";

export interface PushSubscriptionRecord {
  id: string;
}

export interface PushSubscriptionUpsertArgs {
  businessId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel: string | null;
}

export interface PushSubscriptionRepositoryPort {
  upsertInTransaction(tx: Tx, args: PushSubscriptionUpsertArgs): Promise<PushSubscriptionRecord>;
}
