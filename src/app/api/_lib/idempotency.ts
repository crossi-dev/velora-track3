import { createHash, randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { badRequest, conflict } from "@/app/api/_lib/route-helpers";
import { cloudLog } from "@/lib/cloud-logger";

type IdempotencyRecordDelegate = {
  findFirst(args: {
    where: {
      businessId: string;
      actionType: string;
      idempotencyKey: string;
    };
    select: {
      id: true;
      businessId: true;
      actionType: true;
      idempotencyKey: true;
      requestHash: true;
      status: true;
      responseStatus: true;
      responseBody: true;
      createdAt: true;
    };
  }): Promise<IdempotencyRow | null>;
  create(args: {
    data: {
      id: string;
      businessId: string;
      actionType: string;
      idempotencyKey: string;
      requestHash: string;
      status: string;
      createdAt: Date;
      updatedAt: Date;
    };
  }): Promise<unknown>;
  update(args: {
    where: { id: string };
    data: {
      status: string;
      responseStatus: number;
      responseBody: string;
      completedAt: Date;
      updatedAt: Date;
    };
  }): Promise<unknown>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
};

type IdempotencyClient = {
  idempotencyRecord: IdempotencyRecordDelegate;
};

type IdempotencyRow = {
  id: string;
  businessId: string;
  actionType: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  responseStatus: number | null;
  responseBody: string | null;
  createdAt: Date;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // Code-point sort (NOT localeCompare) so the canonical hash is identical
      // across environments regardless of system locale collation.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]);

    return Object.fromEntries(entries);
  }

  return value;
}

function createRequestHash(requestBody: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(requestBody)))
    .digest("hex");
}

function isUniqueConstraintError(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    return (error as { code?: unknown }).code === "P2002";
  }
  return false;
}

function parseStoredResponseBody(raw: string | null) {
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readIdempotencyRow(
  client: IdempotencyClient,
  businessId: string,
  actionType: string,
  idempotencyKey: string
) {
  return client.idempotencyRecord.findFirst({
    where: { businessId, actionType, idempotencyKey },
    select: {
      id: true,
      businessId: true,
      actionType: true,
      idempotencyKey: true,
      requestHash: true,
      status: true,
      responseStatus: true,
      responseBody: true,
      createdAt: true,
    },
  });
}

function buildReplayOrConflictResponse(
  existing: IdempotencyRow,
  requestHash: string,
  req?: { url?: string }
) {
  if (existing.requestHash !== requestHash) {
    return {
      kind: "conflict" as const,
      response: conflict("Esta clave de idempotencia ya se usó para otra solicitud."),
    };
  }

  if (existing.status === "completed") {
    const parsedBody = parseStoredResponseBody(existing.responseBody);
    if (parsedBody) {
      cloudLog({ severity: "INFO", component: "System", action: "IDEMPOTENCY_REPLAY", a2a_transfer: false, message: "Idempotent request replayed from cache", data: { key: existing.idempotencyKey, originalAt: existing.createdAt.toISOString(), route: req?.url } });
      return {
        kind: "replay" as const,
        response: NextResponse.json(parsedBody, { status: existing.responseStatus ?? 200 }),
      };
    }
  }

  return {
    kind: "in_flight" as const,
    response: conflict("Esta solicitud ya se está procesando. Esperá antes de reintentar."),
  };
}

export async function ensureIdempotencyTable(_client: IdempotencyClient) {
  // Kept for compatibility with callers during migration.
  // Schema/indexes are now managed via Prisma migrations on PostgreSQL.
}

export async function pruneIdempotencyRecords(client: IdempotencyClient) {
  const pendingCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const completedCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Remove stale pending records (stuck for > 5 minutes — request never completed or released)
  await client.idempotencyRecord.deleteMany({
    where: { status: "pending", updatedAt: { lt: pendingCutoff } },
  });

  // Remove old completed records (> 30 days — no longer needed for replay protection)
  await client.idempotencyRecord.deleteMany({
    where: { status: "completed", completedAt: { lt: completedCutoff } },
  });
}

export function getIdempotencyKey(req: NextRequest) {
  return req.headers.get("x-idempotency-key")?.trim().slice(0, 256) ?? "";
}

export async function beginIdempotentMutation(args: {
  client: IdempotencyClient;
  businessId: string;
  actionType: string;
  idempotencyKey: string;
  requestBody: unknown;
  req?: { url?: string };
}) {
  const { client, businessId, actionType, idempotencyKey, requestBody, req } = args;

  if (!idempotencyKey) {
    return {
      kind: "missing" as const,
      response: badRequest("Falta el encabezado X-Idempotency-Key."),
    };
  }

  await ensureIdempotencyTable(client);
  // Pruning moved to the daily audit-cleanup cron (cleanIdempotencyRecord +
  // cleanStuckPendingIdempotencyRecords). Calling deleteMany on every hot-path
  // mutation write was causing unnecessary DB load under traffic.

  const requestHash = createRequestHash(requestBody);
  const now = new Date();
  const recordId = randomUUID().replace(/-/g, "");

  // Atomicity guarantee: attempt the insert FIRST and rely on the
  // unique index on (businessId, actionType, idempotencyKey) to
  // arbitrate concurrent requests. Only one of two simultaneous inserts
  // with the same key can succeed; the loser gets P2002 and falls back
  // to replay/conflict/in_flight via buildReplayOrConflictResponse.
  // This removes the read-then-insert race window.
  try {
    await client.idempotencyRecord.create({
      data: {
        id: recordId,
        businessId,
        actionType,
        idempotencyKey,
        requestHash,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const collided = await readIdempotencyRow(client, businessId, actionType, idempotencyKey);
    if (collided) {
      return buildReplayOrConflictResponse(collided, requestHash, req);
    }

    // P2002 + readback miss = la fila colisionó pero la pruning/race ya la borró.
    // Es funcionalmente un conflicto; mapearlo a 409 evita reportar un 500 espurio
    // que dispara incidentes y rompe el contrato de idempotency en el cliente.
    cloudLog({ severity: "WARNING", component: "System", action: "IDEMPOTENCY_RACE_RESOLVED", a2a_transfer: false, message: "P2002 collision but readback miss — race likely resolved by prune", businessId, data: { actionType, idempotencyKey } });
    return {
      kind: "conflict" as const,
      response: conflict("Esta clave de idempotencia ya se usó. Reintentá con otra clave."),
    };
  }

  return {
    kind: "execute" as const,
    recordId,
  };
}

export async function completeIdempotentMutation(args: {
  client: IdempotencyClient;
  recordId: string;
  responseStatus: number;
  responseBody: unknown;
}) {
  const { client, recordId, responseStatus, responseBody } = args;

  await ensureIdempotencyTable(client);

  const now = new Date();
  await client.idempotencyRecord.update({
    where: { id: recordId },
    data: {
      status: "completed",
      responseStatus,
      responseBody: JSON.stringify(responseBody),
      completedAt: now,
      updatedAt: now,
    },
  });
}

export async function releaseIdempotentMutation(args: {
  client: IdempotencyClient;
  recordId: string | null;
}) {
  const { client, recordId } = args;
  if (!recordId) return;

  // Release is best-effort. If this fails during a catch path, we must not
  // mask the original error. pruneIdempotencyRecords (TTL 5 min) cleans up
  // any stuck pending rows.
  try {
    await ensureIdempotencyTable(client);
    await client.idempotencyRecord.deleteMany({
      where: { id: recordId, status: "pending" },
    });
  } catch (releaseError) {
    cloudLog({ severity: "WARNING", component: "System", action: "IDEMPOTENCY_RELEASE_FAILED", a2a_transfer: false, message: "[idempotency] release failed — pending row stuck until TTL prune", data: { recordId, error: releaseError instanceof Error ? releaseError.message : String(releaseError) } });
  }
}
