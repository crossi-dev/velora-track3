// disconnect-use-case.ts — use-case for disconnecting an ARCA/AFIP credential.
//
// Mirrors mp/_lib/disconnect-use-case.ts in structure.
//
// Flow:
//   1. Idempotency guard (header key, same as MP).
//   2. Look up existing ArcaCredential row.
//   3. Best-effort delete of the .p12 cert from GCS — if GCS fails (network,
//      IAM), log WARNING and continue. The cert without a DB row is dead data;
//      the owner explicitly requested disconnection.
//   4. Delete ArcaCredential row (P2025 = already gone, treat as success).
//   5. Complete idempotency + recordCriticalWriteEvent.
//
// NEVER logs or returns certGcsPath, encryptedPassphrase, or any crypto material.

import { Prisma } from "@prisma/client";
import { Storage } from "@google-cloud/storage";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";

const DISCONNECT_ACTION = getServerActionMeta("arca_credential.disconnect");

export interface DisconnectArcaInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  idempotencyKey: string;
}

export type DisconnectArcaResult =
  | { outcome: "disconnected"; businessId: string }
  | { outcome: "not_connected" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

export async function disconnectArcaUseCase(
  input: DisconnectArcaInput,
): Promise<DisconnectArcaResult> {
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
    const existing = await prisma.arcaCredential.findUnique({
      where: { businessId: input.businessId },
      // Never select encryptedPassphrase or certGcsPath in the return — only what we need.
      select: { id: true, certGcsPath: true },
    });

    if (!existing) {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return { outcome: "not_connected" };
    }

    // ── Best-effort GCS delete ────────────────────────────────────────────────
    // Failure here does NOT abort the disconnect. The cert is worthless without
    // a matching DB credential row (we don't store which businessId it belongs
    // to on GCS — the filename IS the businessId, but callers can't decrypt it
    // without the DB row's encryptedPassphrase).
    try {
      const storage = new Storage();
      const bucket = process.env.ARCA_CERT_BUCKET ?? "velora-arca-certs";
      await storage.bucket(bucket).file(existing.certGcsPath).delete({ ignoreNotFound: true });
    } catch (gcsErr) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "integrations/fiscal/disconnect",
        a2a_transfer: false,
        message: "GCS cert delete failed during ARCA disconnect — proceeding with DB deletion",
        data: {
          businessId: input.businessId,
          error: gcsErr instanceof Error ? gcsErr.message : String(gcsErr),
        },
      });
    }

    // ── Delete ArcaCredential row ─────────────────────────────────────────────
    try {
      await prisma.arcaCredential.delete({ where: { businessId: input.businessId } });
    } catch (err) {
      // P2025 — already deleted (race). Treat as success.
      const isNotFound =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
      if (!isNotFound) throw err;
    }

    const responseBody = { ok: true, businessId: input.businessId };
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
      resourceId: input.businessId,
      summary: "ARCA desconectado",
      // SAFE metadata only — no cert path, no passphrase.
      payload: { businessId: input.businessId },
    });

    return { outcome: "disconnected", businessId: input.businessId };
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw error;
  }
}
