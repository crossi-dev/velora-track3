import "server-only";
// caja-saldo-tool.ts — caja.consultar_saldo: real DB cash balance query.
//
// Source: Square GET /v2/cash-drawers/shifts/{shift_id} (verified HTTP 200 2026-06-02)
//   https://developer.squareup.com/reference/square/objects/CashDrawerShift
//   expected_cash_money = opened + cash_paid_in − cash_paid_out − refunds
//
// Fix: previously the Supervisor LLM hallucinated the balance from memory.
// This tool performs the real DB query so the agent returns a grounded answer.
//
// Part B (feat/caja-pilot-harden-modularize):
//   prisma calls delegated to CajaBackend port (velora-caja.adapter.ts).

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "./_shared/create-tool";
import type { CajaToolsBackend } from "./caja-tools";
import { createCajaBackend } from "@/lib/mcp/_lib/caja-backend.factory";

const ConsultarSaldoInput = z.object({});

const CONSULTAR_SALDO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {},
};

export function createConsultarSaldoTool(backend: CajaToolsBackend) {
  return createTool({
    name: "caja.consultar_saldo",
    description:
      "Consulta el saldo actual de la caja. Busca el turno abierto y suma todos los " +
      "movimientos del período para calcular el saldo esperado en efectivo. " +
      "Siempre usar este tool — nunca inventar el saldo.",
    schema: CONSULTAR_SALDO_SCHEMA,
    inputSchema: ConsultarSaldoInput,
    backend,
    execute: async ({ backend: b }) => {
      const { businessId } = b;
      const cajaBackend = createCajaBackend();

      const openSession = await cajaBackend.findOpenSessionWithAmount(businessId);

      if (!openSession) {
        // No open session — return last closed session's closing balance.
        const lastClosed = await cajaBackend.findLastClosedSession(businessId);
        if (!lastClosed) {
          return {
            state: "NO_SESSION",
            message: "No hay turno de caja abierto ni historial previo para este negocio.",
          };
        }
        return {
          state: "CLOSED",
          sessionId: lastClosed.id,
          closedAt: lastClosed.closedAt,
          closedCashAmount: lastClosed.closedCashAmount,
          variance: lastClosed.variance,
          message: `El turno anterior cerró con $${(lastClosed.closedCashAmount ?? 0).toLocaleString("es-AR")} en caja.`,
        };
      }

      // C1: filter to cash-only movements — QR/transferencia sales do NOT move
      // physical cash. paymentMethod "efectivo" or null (legacy pre-column rows)
      // are the only movements that should count toward the physical cash balance.
      // CashMovement.amount is pre-signed (inflows positive, outflows negative).
      const movements = await cajaBackend.findCashMovementsForSession({
        businessId,
        fromDate: openSession.openedAt,
      });

      const totalInflows = movements
        .filter((m) => m.amount > 0)
        .reduce((s, m) => s + m.amount, 0);

      const totalOutflows = movements
        .filter((m) => m.amount < 0)
        .reduce((s, m) => s + m.amount, 0);

      const expectedCashAmount =
        openSession.openedCashAmount + totalInflows + totalOutflows; // outflows are negative

      return {
        state: "OPEN",
        sessionId: openSession.id,
        openedAt: openSession.openedAt.toISOString(),
        openedCashAmount: openSession.openedCashAmount,
        totalInflows,
        totalOutflows: Math.abs(totalOutflows),
        expectedCashAmount,
        movementCount: movements.length,
        message: `Saldo esperado en caja: $${expectedCashAmount.toLocaleString("es-AR")} (fondo $${openSession.openedCashAmount.toLocaleString("es-AR")} + ingresos $${totalInflows.toLocaleString("es-AR")} − egresos $${Math.abs(totalOutflows).toLocaleString("es-AR")}).`,
      };
    },
  });
}
