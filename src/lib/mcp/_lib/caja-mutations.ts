import "server-only";
// src/lib/mcp/_lib/caja-mutations.ts — Mutation handlers for caja-tools.ts.
// Extracted to keep caja-tools.ts under the 250-line project limit.
// MONEY PATH — do NOT relax:
//   beginIdempotentMutation → DB write → completeIdempotentMutation
//   recordCriticalWriteEvent (financial event)
// References: ADK caja-ciclo-tool.ts + caja-movimiento-tool.ts (source pattern).

import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { prisma } from "@/lib/prisma";
import type { CajaBackend } from "./caja-backend.port";
import { errResponse as errCajaResponse } from "./mcp-responses";

// ── Shared constants ──────────────────────────────────────────────────────────

export const TIPO_ES_TO_DOMAIN: Record<string, string> = {
  ingreso: "income",
  gasto: "purchase",
  retiro: "withdrawal",
  sangria: "withdrawal",
  "sangría": "withdrawal",
  impuesto: "tax",
  sueldo: "salary",
};

export const TIPO_LABEL: Record<string, string> = {
  income: "Ingreso",
  purchase: "Gasto",
  withdrawal: "Retiro / Sangría",
  tax: "Impuesto",
  salary: "Sueldo",
};

// ── handleCicloCajaAbrir ──────────────────────────────────────────────────────

export async function handleCicloCajaAbrir(
  businessId: string,
  backend: CajaBackend,
  derivedKey: string,
  monto: number,
  nota: string | undefined,
) {
  const existing = await backend.findOpenSession(businessId);
  if (existing) {
    return errCajaResponse(
      "SESSION_ALREADY_OPEN",
      `A cash shift is already open since ${existing.openedAt.toISOString()}. Close it before opening a new one.`,
    );
  }

  const idem = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: "caja.session.open",
    idempotencyKey: derivedKey,
    requestBody: { action: "abrir", monto },
  });
  if (idem.kind === "replay") {
    const body = await (idem.response as Response).json().catch(() => null);
    return { content: [{ type: "text" as const, text: JSON.stringify(body ?? { replayed: true }) }] };
  }
  if (idem.kind !== "execute") {
    return errCajaResponse("IDEMPOTENCY_CONFLICT", "Idempotency conflict on open. Retry.");
  }
  const { recordId } = idem;

  let session: { id: string; openedAt: Date };
  try {
    session = await backend.createSession({
      businessId,
      openedCashAmount: monto,
      openNote: nota ?? null,
      openedByEmployeeId: null,
    });
    await completeIdempotentMutation({
      client: prisma,
      recordId,
      responseStatus: 201,
      responseBody: { sessionId: session.id, state: "OPEN", openedAt: session.openedAt },
    });
  } catch (err) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    if (
      typeof err === "object" && err !== null && "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      return errCajaResponse("SESSION_ALREADY_OPEN", "A cash shift is already open. Close it before opening a new one.");
    }
    throw err;
  }

  await recordCriticalWriteEvent({
    client: prisma,
    businessId,
    actorUserId: "mcp-system",
    actorEmployeeId: null,
    routeScope: "caja/session/open",
    actionType: "caja.session.open",
    resourceType: "caja_session",
    resourceId: session.id,
    summary: `Cash shift opened with float $${monto}`,
    payload: { sessionId: session.id, monto, nota },
    after: { sessionId: session.id, state: "OPEN", openedAt: session.openedAt.toISOString() },
  });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ sessionId: session.id, state: "OPEN", openedAt: session.openedAt.toISOString(), openedCashAmount: monto }),
    }],
  };
}

// ── handleCicloCajaCerrar ─────────────────────────────────────────────────────

export async function handleCicloCajaCerrar(
  businessId: string,
  backend: CajaBackend,
  derivedKey: string,
  monto: number,
  nota: string | undefined,
) {
  const openSession = await backend.findOpenSessionWithAmount(businessId);
  if (!openSession) {
    return errCajaResponse("NO_OPEN_SESSION", "No open cash shift to close.");
  }

  const closeTime = new Date();
  const movements = await backend.findCashMovementsForSession({
    businessId,
    fromDate: openSession.openedAt,
    toDate: closeTime,
  });

  const netMovements = movements.reduce((sum, m) => sum + m.amount, 0);
  const expectedCashAmount = openSession.openedCashAmount + netMovements;
  const variance = monto - expectedCashAmount;

  const idem = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: "caja.session.close",
    idempotencyKey: derivedKey,
    requestBody: { action: "cerrar", sessionId: openSession.id, monto },
  });
  if (idem.kind === "replay") {
    const body = await (idem.response as Response).json().catch(() => null);
    return { content: [{ type: "text" as const, text: JSON.stringify(body ?? { replayed: true }) }] };
  }
  if (idem.kind !== "execute") {
    return errCajaResponse("IDEMPOTENCY_CONFLICT", "Idempotency conflict on close. Retry.");
  }
  const { recordId } = idem;

  let closed: { closedAt: Date | null };
  try {
    closed = await backend.closeSession({
      sessionId: openSession.id,
      businessId,
      closedCashAmount: monto,
      expectedCashAmount,
      variance,
      closedAt: closeTime,
      closeNote: nota ?? null, closedByEmployeeId: null,
    });
    await completeIdempotentMutation({
      client: prisma,
      recordId,
      responseStatus: 200,
      responseBody: { sessionId: openSession.id, state: "CLOSED", closedCashAmount: monto, expectedCashAmount, variance },
    });
  } catch (err) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw err;
  }

  await recordCriticalWriteEvent({
    client: prisma,
    businessId,
    actorUserId: "mcp-system",
    actorEmployeeId: null,
    routeScope: "caja/session/close",
    actionType: "caja.session.close",
    resourceType: "caja_session",
    resourceId: openSession.id,
    summary: `Cash shift closed. Counted: $${monto}, Expected: $${expectedCashAmount.toFixed(2)}, Variance: $${variance.toFixed(2)}`,
    payload: { sessionId: openSession.id, closed: monto, expected: expectedCashAmount, variance },
    before: { state: "OPEN", openedCashAmount: openSession.openedCashAmount },
    after: { state: "CLOSED", closedCashAmount: monto, expectedCashAmount, variance },
  });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        sessionId: openSession.id,
        state: "CLOSED",
        closedAt: closed.closedAt?.toISOString() ?? closeTime.toISOString(),
        closedCashAmount: monto,
        expectedCashAmount,
        variance,
      }),
    }],
  };
}

// ── handleRegistrarMovimiento ─────────────────────────────────────────────────

export async function handleRegistrarMovimiento(
  businessId: string,
  backend: CajaBackend,
  derivedKey: string,
  tipo: string,
  monto: number,
  descripcion: string,
) {
  const domainType = TIPO_ES_TO_DOMAIN[tipo];
  if (!domainType) {
    return errCajaResponse("INVALID_TYPE", `Unknown movement type: ${tipo}`);
  }

  const idem = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: "caja.movement.create",
    idempotencyKey: derivedKey,
    requestBody: { tipo, monto, descripcion },
  });
  if (idem.kind === "replay") {
    const body = await (idem.response as Response).json().catch(() => null);
    return { content: [{ type: "text" as const, text: JSON.stringify(body ?? { replayed: true }) }] };
  }
  if (idem.kind !== "execute") {
    return errCajaResponse("IDEMPOTENCY_CONFLICT", "Idempotency conflict. Retry.");
  }
  const { recordId } = idem;

  let movementId: string;
  let storedAmount: number;
  try {
    const created = await backend.createMovement({
      businessId,
      domainType,
      description: descripcion,
      amount: monto,
      clientMessageId: derivedKey,
    });
    movementId = created.id;
    storedAmount = created.amount;
    await completeIdempotentMutation({
      client: prisma,
      recordId,
      responseStatus: 201,
      responseBody: { movementId, type: domainType, amount: storedAmount },
    });
  } catch (err) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw err;
  }

  await recordCriticalWriteEvent({
    client: prisma,
    businessId,
    actorUserId: "mcp-system",
    actorEmployeeId: null,
    routeScope: "caja/movements",
    actionType: "caja.movement.create",
    resourceType: "cash_movement",
    resourceId: movementId,
    summary: `Cash movement: ${tipo} $${monto} — ${descripcion}`,
    payload: { movementId, tipo, domainType, monto, descripcion },
    after: { movementId, type: domainType, amount: storedAmount },
  });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        movementId,
        type: domainType,
        typeLabel: TIPO_LABEL[domainType] ?? domainType,
        amount: storedAmount,
        descripcion,
      }),
    }],
  };
}
