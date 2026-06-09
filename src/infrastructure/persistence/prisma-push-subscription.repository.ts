import type { PushSubscriptionRepositoryPort, PushSubscriptionUpsertArgs } from "@/domain/ports/push-subscription.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

export const prismaPushSubscriptionRepository: PushSubscriptionRepositoryPort = {
  async upsertInTransaction(tx: Tx, args: PushSubscriptionUpsertArgs) {
    const prismaTx = toPrismaTx(tx);
    return prismaTx.pushSubscription.upsert({
      where: { businessId_endpoint: { businessId: args.businessId, endpoint: args.endpoint } },
      update: {
        userId: args.userId,
        p256dh: args.p256dh,
        auth: args.auth,
        deviceLabel: args.deviceLabel ?? undefined,
        expired: false,
      },
      create: {
        businessId: args.businessId,
        userId: args.userId,
        endpoint: args.endpoint,
        p256dh: args.p256dh,
        auth: args.auth,
        deviceLabel: args.deviceLabel,
      },
      select: { id: true },
    });
  },
};
