import { prisma } from "@/lib/prisma";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import type { IdempotencyPort, BeginIdempotencyArgs, IdempotencyOutcome } from "@/domain/ports/idempotency.port";
import type { Tx } from "@/domain/ports/tx";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

export const prismaIdempotencyAdapter: IdempotencyPort = {
  async begin(args: BeginIdempotencyArgs): Promise<IdempotencyOutcome> {
    const result = await beginIdempotentMutation({
      client: prisma,
      businessId: args.businessId,
      actionType: args.actionType,
      idempotencyKey: args.idempotencyKey,
      requestBody: args.requestBody,
    });

    if (result.kind === "execute") return { kind: "execute", recordId: result.recordId };
    if (result.kind === "replay") {
      const body = await result.response.json() as unknown;
      return { kind: "replay", status: result.response.status, body };
    }
    return { kind: result.kind };
  },

  async complete(tx: Tx | null, recordId: string, status: number, body: unknown): Promise<void> {
    const client = tx ? toPrismaTx(tx) : prisma;
    await completeIdempotentMutation({ client, recordId, responseStatus: status, responseBody: body });
  },

  async release(recordId: string | null): Promise<void> {
    await releaseIdempotentMutation({ client: prisma, recordId });
  },
};
