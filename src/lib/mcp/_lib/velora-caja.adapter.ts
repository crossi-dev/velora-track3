import "server-only";
// src/lib/mcp/_lib/velora-caja.adapter.ts — Velora concrete implementation of CajaBackend.
//
// Delegates to the EXISTING Prisma schema tables:
//   - prisma.cajaSession   — open/close shift lifecycle
//   - prisma.cashMovement  — individual cash-in / cash-out entries (via shared cash-mutations)
//
// Pure restructure — zero behavioral change. Every query condition preserved exactly
// from the original caja-ciclo-tool.ts and caja-saldo-tool.ts direct-prisma calls.
//
// C1 invariant: only cash movements with paymentMethod "efectivo" or null (legacy) are
// counted toward physical cash balance. This filter lives here, not in the tool.
//
// Design source: velora-payments.adapter.ts (composition over inheritance).
//
// HARD CONSTRAINTS (money path — do NOT relax):
//   - Do NOT add or remove idempotency here (tools own that).
//   - Do NOT modify the cash-mutations sign convention (signCashMovementAmount owns sign).
//   - Every query MUST include businessId in the WHERE clause (tenant isolation).
//   - Prisma Decimal returned by cashMovement.amount is cast to Number here so the
//     port boundary is Decimal-free (INV-6: Decimal leaks break JSON serialization).

import type {
  CajaBackend,
  OpenSessionResult,
  ClosedSessionResult,
  MovementResult,
  CreateSessionInput,
  CreateSessionResult,
  CloseSessionInput,
  CloseSessionResult,
  CreateMovementInput,
  CreateMovementResult,
  FindMovementsInput,
} from "./caja-backend.port";
import { prisma } from "@/lib/prisma";
import {
  createCashMovementInTransaction,
  type CashMovementType,
} from "@/infrastructure/shared/cash-mutations";
import type { Prisma } from "@prisma/client";

export class VeloraCajaAdapter implements CajaBackend {
  async findOpenSession(businessId: string): Promise<{ id: string; openedAt: Date } | null> {
    return prisma.cajaSession.findFirst({
      where: { businessId, state: "OPEN" },
      select: { id: true, openedAt: true },
    });
  }

  async findOpenSessionWithAmount(businessId: string): Promise<OpenSessionResult | null> {
    const row = await prisma.cajaSession.findFirst({
      where: { businessId, state: "OPEN" },
      select: { id: true, openedAt: true, openedCashAmount: true },
      orderBy: { openedAt: "asc" },
    });
    if (!row) return null;
    return {
      id: row.id,
      openedAt: row.openedAt,
      // Prisma Decimal → number at the port boundary (INV-6).
      openedCashAmount: Number(row.openedCashAmount),
    };
  }

  async findLastClosedSession(businessId: string): Promise<ClosedSessionResult | null> {
    const row = await prisma.cajaSession.findFirst({
      where: { businessId, state: "CLOSED" },
      orderBy: { closedAt: "desc" },
      select: { id: true, closedAt: true, closedCashAmount: true, variance: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      closedAt: row.closedAt?.toISOString() ?? null,
      closedCashAmount: row.closedCashAmount !== null ? Number(row.closedCashAmount) : null,
      variance: row.variance !== null ? Number(row.variance) : null,
    };
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const row = await prisma.cajaSession.create({
      data: {
        businessId: input.businessId,
        state: "OPEN",
        openedCashAmount: input.openedCashAmount,
        openNote: input.openNote,
        openedByEmployeeId: input.openedByEmployeeId,
      },
      select: { id: true, openedAt: true },
    });
    return { id: row.id, openedAt: row.openedAt };
  }

  async closeSession(input: CloseSessionInput): Promise<CloseSessionResult> {
    // Tenant fence at the DB layer (HARD CONSTRAINT above: every query MUST scope
    // by businessId). updateMany — not update — so the compound {id, businessId}
    // filter is allowed; count === 0 means the session is not this tenant's
    // (or doesn't exist) and the close is rejected instead of silently no-op'd.
    const res = await prisma.cajaSession.updateMany({
      where: { id: input.sessionId, businessId: input.businessId },
      data: {
        state: "CLOSED",
        closedCashAmount: input.closedCashAmount,
        expectedCashAmount: input.expectedCashAmount,
        variance: input.variance,
        closedAt: input.closedAt,
        closeNote: input.closeNote,
        closedByEmployeeId: input.closedByEmployeeId,
      },
    });
    if (res.count === 0) throw new Error("CAJA_SESSION_NOT_FOUND");
    return { closedAt: input.closedAt };
  }

  async findCashMovementsForSession(input: FindMovementsInput): Promise<MovementResult[]> {
    // C1: filter to cash-only movements — QR/transferencia sales do NOT move
    // physical cash. paymentMethod "efectivo" or null (legacy pre-column rows).
    // C5 (ciclo_caja close path): when toDate is provided, bound the upper end so
    // movements written by a concurrent next-shift open are not counted.
    const rows = await prisma.cashMovement.findMany({
      where: {
        businessId: input.businessId,
        date: {
          gte: input.fromDate,
          ...(input.toDate ? { lte: input.toDate } : {}),
        },
        // Prisma nullable String: { in: [..., null] } is not typed correctly.
        // Use OR to cover "efectivo" rows AND legacy null rows.
        OR: [
          { paymentMethod: "efectivo" },
          { paymentMethod: null },
        ],
      },
      select: { amount: true, type: true, description: true, date: true },
      orderBy: { date: "desc" },
    });
    // Decimal → number at the port boundary (INV-6).
    return rows.map((r) => ({
      amount: Number(r.amount),
      type: r.type,
      description: r.description,
      date: r.date.toISOString(),
    }));
  }

  async createMovement(input: CreateMovementInput): Promise<CreateMovementResult> {
    const created = await prisma.$transaction(async (tx) => {
      // Cast to Prisma.TransactionClient: the extended client shape from
      // buildTenantExtension differs from Prisma.TransactionClient in
      // generic constraints only. Established pattern per INV-5 in lib/prisma.ts.
      const baseTx = tx as unknown as Prisma.TransactionClient;
      return createCashMovementInTransaction(baseTx, {
        businessId: input.businessId,
        type: input.domainType as CashMovementType,
        description: input.description,
        amount: input.amount,
        date: new Date(),
        clientMessageId: input.clientMessageId,
      });
    });
    return {
      id: created.id,
      // Decimal → number at the port boundary (INV-6).
      amount: Number(created.amount),
    };
  }
}
