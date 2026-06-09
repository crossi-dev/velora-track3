// Use-case del disconnect Mercado Pago — slice 7.
// Borra MpConnection del negocio + audit + idempotency.
//
// V1 NO intenta revocar el token contra MP. El dueño se rebusca para
// desautorizar Velora desde el panel MP si quiere borrarlo del lado de MP.
// Best effort sobre nuestro side: la fila se va, los slices futuros que
// requieren accessToken bailan limpio (getValidAccessToken devuelve null).

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";

const DISCONNECT_ACTION = getServerActionMeta("mp_connection.disconnect");

export interface DisconnectMpInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  idempotencyKey: string;
}

export type DisconnectMpResult =
  | { outcome: "disconnected"; mpUserId: string | null }
  | { outcome: "not_connected" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

export async function disconnectMpUseCase(
  input: DisconnectMpInput,
): Promise<DisconnectMpResult> {
  const idempotency = await beginIdempotentMutation({
    client: prisma,
    businessId: input.businessId,
    actionType: DISCONNECT_ACTION.actionType,
    idempotencyKey: input.idempotencyKey,
    requestBody: { businessId: input.businessId },
  });

  if (idempotency.kind === "replay") {
    const body = await idempotency.response.json();
    return { outcome: "replayed", status: idempotency.response.status, body };
  }
  if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
  if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
  if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

  const recordId = idempotency.recordId;
  try {
    const existing = await prisma.mpConnection.findUnique({
      where: { businessId: input.businessId },
      select: { mpUserId: true },
    });
    if (!existing) {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return { outcome: "not_connected" };
    }

    try {
      await prisma.mpConnection.delete({ where: { businessId: input.businessId } });
    } catch (error) {
      // P2025 — already gone (race con otro disconnect). Tratar como éxito.
      const isNotFound =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
      if (!isNotFound) throw error;
    }

    const responseBody = { ok: true, mpUserId: existing.mpUserId };
    await completeIdempotentMutation({
      client: prisma,
      recordId,
      responseStatus: 200,
      responseBody,
    });
    await recordCriticalWriteEvent({
      client: prisma,
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      actorEmployeeId: input.actorEmployeeId,
      routeScope: DISCONNECT_ACTION.routeScope,
      actionType: DISCONNECT_ACTION.actionType,
      resourceType: DISCONNECT_ACTION.resourceType,
      resourceId: existing.mpUserId,
      summary: `Mercado Pago desconectado (${existing.mpUserId})`,
      payload: { mpUserId: existing.mpUserId },
    });
    return { outcome: "disconnected", mpUserId: existing.mpUserId };
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw error;
  }
}
