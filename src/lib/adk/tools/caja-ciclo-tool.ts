import "server-only";
// caja-ciclo-tool.ts — caja.ciclo_caja: abrir / cerrar turno de caja.
//
// Source: Square CashDrawerShift API (verified HTTP 200 2026-06-02)
//   https://developer.squareup.com/reference/square/objects/CashDrawerShift
//   opened_cash_money = float declared by the opener
//   closed_cash_money = cash physically counted by the closer
//   expected           = opened + net cash movements (computed by us, no API field)
//   variance           = closed − expected (negative = shortage)
//
// Part A (feat/caja-pilot-harden-modularize):
//   idempotency_key REMOVED from LLM-visible schema. Key is now derived
//   server-side via turnIdempotency (deriveServerKey) — LLM cannot influence it.
//   Part B: prisma calls delegated to CajaBackend port (velora-caja.adapter.ts).

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool, serverTurnId } from "./_shared/create-tool";
import type { CajaToolsBackend } from "./caja-tools";
import { createCajaBackend } from "@/lib/mcp/_lib/caja-backend.factory";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { prisma } from "@/lib/prisma";

const CicloCajaInput = z.object({
  action: z.enum(["abrir", "cerrar"], {
    errorMap: () => ({ message: "Acción debe ser 'abrir' o 'cerrar'." }),
  }),
  monto: z
    .number()
    .finite()
    .min(0, "El monto no puede ser negativo.")
    .describe("Fondo de caja al abrir, o efectivo contado al cerrar."),
  nota: z.string().max(500).optional().describe("Nota opcional del operador."),
});

const CICLO_CAJA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    action: {
      type: Type.STRING,
      description: "Operación a ejecutar: 'abrir' para iniciar el turno, 'cerrar' para cerrarlo.",
    },
    monto: {
      type: Type.NUMBER,
      description:
        "Al abrir: fondo inicial declarado (float de apertura). Al cerrar: efectivo físicamente contado.",
    },
    nota: {
      type: Type.STRING,
      description: "Nota opcional del operador (ej: 'apertura turno mañana').",
    },
  },
  required: ["action", "monto"],
};

export function createCicloCajaTool(backend: CajaToolsBackend) {
  return createTool({
    name: "caja.ciclo_caja",
    // C3: rethrowErrors — a DB failure on open/close must hard-stop the ADK runner.
    // A soft { error } envelope here would let the LLM hallucinate a successful shift
    // open/close on a failed write. Money path: fail loud, not silent.
    rethrowErrors: true,
    description:
      "Abre o cierra el turno de caja (ciclo de arqueo). " +
      "Para abrir: registra el fondo inicial de la caja. " +
      "Para cerrar: registra el efectivo contado, calcula el saldo esperado " +
      "sumando los movimientos del turno, y determina la diferencia (faltante/sobrante). " +
      "Solo puede haber un turno abierto por negocio a la vez.",
    schema: CICLO_CAJA_SCHEMA,
    inputSchema: CicloCajaInput,
    backend,
    // Part A: server-derived idempotency — LLM cannot influence the key.
    // Key = SHA-256(turnId | "caja.ciclo_caja" | canonical(input)).slice(0,32)
    // turnId is the RPC contextId threaded from handle-caja-rpc.ts (stable per request,
    // same across Cloud Run retries of the same RPC call, distinct across different calls).
    // actionType is per-action: the execute body selects open vs close at runtime.
    // NOTE: open and close have DIFFERENT actionTypes but share the same turnId seam;
    // the tool name + input.action difference means deriveServerKey produces distinct keys.
    turnIdempotency: {
      turnId: serverTurnId(backend.turnId),
      businessId: backend.businessId,
      // actionType here is a discriminant for the factory seam; the execute body calls
      // beginIdempotentMutation with the precise per-action actionType (open vs close).
      actionType: "caja.session.open",
    },
    execute: async ({ input, backend: b, idempotency }) => {
      const { businessId, actorUserId, actorEmployeeId } = b;
      const cajaBackend = createCajaBackend();
      // idempotency.key is server-derived — never LLM-supplied.
      // The same key is produced for the same (turnId, toolName, input) triple.
      const derivedKey = idempotency!.key;

      if (input.action === "abrir") {
        const existing = await cajaBackend.findOpenSession(businessId);
        if (existing) {
          return {
            error: {
              code: "SESSION_ALREADY_OPEN",
              message: `Ya hay un turno de caja abierto desde ${existing.openedAt.toLocaleString("es-AR")}. Cerralo antes de abrir uno nuevo.`,
            },
          };
        }

        const idem = await beginIdempotentMutation({
          client: prisma,
          businessId,
          actionType: "caja.session.open",
          idempotencyKey: derivedKey,
          requestBody: { action: "abrir", monto: input.monto },
        });
        if (idem.kind === "replay") {
          const replayBody = await (idem.response as Response).json().catch(() => null);
          return replayBody ?? { replayed: true, message: "Apertura de caja ya registrada." };
        }
        if (idem.kind !== "execute") {
          return { error: { code: "IDEMPOTENCY_CONFLICT", message: "Conflicto de idempotencia al abrir caja. Reintentá." } };
        }
        const { recordId } = idem;

        let session: { id: string; openedAt: Date };
        try {
          session = await cajaBackend.createSession({
            businessId,
            openedCashAmount: input.monto,
            openNote: input.nota ?? null,
            openedByEmployeeId: actorEmployeeId ?? null,
          });
          await completeIdempotentMutation({
            client: prisma,
            recordId,
            responseStatus: 201,
            responseBody: { sessionId: session.id, state: "OPEN", openedAt: session.openedAt },
          });
        } catch (err) {
          await releaseIdempotentMutation({ client: prisma, recordId });
          // C2: the partial unique index "CajaSession_businessId_open_unique"
          // (state='OPEN') fires P2002 when a concurrent create races past the
          // findFirst check. Return a structured error instead of a 5xx so the
          // LLM can surface a clean message to the user.
          if (
            typeof err === "object" &&
            err !== null &&
            "code" in err &&
            (err as { code: string }).code === "P2002"
          ) {
            return {
              error: {
                code: "SESSION_ALREADY_OPEN",
                message: "Ya hay un turno de caja abierto. Cerralo antes de abrir uno nuevo.",
              },
            };
          }
          throw err;
        }

        await recordCriticalWriteEvent({
          client: prisma,
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: "caja/session/open",
          actionType: "caja.session.open",
          resourceType: "caja_session",
          resourceId: session.id,
          summary: `Turno de caja abierto con fondo de $${input.monto}`,
          payload: { sessionId: session.id, monto: input.monto, nota: input.nota },
          after: { sessionId: session.id, state: "OPEN", openedAt: session.openedAt.toISOString() },
        });

        return {
          sessionId: session.id,
          state: "OPEN",
          openedAt: session.openedAt.toISOString(),
          openedCashAmount: input.monto,
          message: `Caja abierta con fondo de $${input.monto.toLocaleString("es-AR")}.`,
        };
      }

      // action === "cerrar"
      const openSession = await cajaBackend.findOpenSessionWithAmount(businessId);
      if (!openSession) {
        return { error: { code: "NO_OPEN_SESSION", message: "No hay un turno de caja abierto para cerrar." } };
      }

      // C1: filter to cash-only movements — QR/transferencia sales do NOT move
      // physical cash, so their CashMovement rows must be excluded from
      // expectedCashAmount. Cash movements have paymentMethod "efectivo" or null
      // (legacy rows written before the column existed).
      // C5: bound upper end to closeTime so any movement written by a concurrent
      // next-shift open is not counted in this shift's expected total.
      const closeTime = new Date();
      const movements = await cajaBackend.findCashMovementsForSession({
        businessId,
        fromDate: openSession.openedAt,
        toDate: closeTime,
      });

      const netMovements = movements.reduce((sum, m) => sum + m.amount, 0);
      const expectedCashAmount = openSession.openedCashAmount + netMovements;
      const variance = input.monto - expectedCashAmount;

      // Derive the close key — same turnId but action="cerrar" produces a different
      // canonical input, so deriveServerKey yields a distinct key from the open case.
      // We pass derivedKey (already action-scoped by the factory) to the mutation.
      const idem = await beginIdempotentMutation({
        client: prisma,
        businessId,
        actionType: "caja.session.close",
        idempotencyKey: derivedKey,
        requestBody: { action: "cerrar", sessionId: openSession.id, monto: input.monto },
      });
      if (idem.kind === "replay") {
        const replayBody = await (idem.response as Response).json().catch(() => null);
        return replayBody ?? { replayed: true, message: "Cierre de caja ya registrado." };
      }
      if (idem.kind !== "execute") {
        return { error: { code: "IDEMPOTENCY_CONFLICT", message: "Conflicto de idempotencia al cerrar caja. Reintentá." } };
      }
      const { recordId } = idem;

      let closed: { closedAt: Date | null };
      try {
        // C5: reuse closeTime so closedAt == the query upper bound — movements
        // written after this instant are definitionally next-shift's responsibility.
        closed = await cajaBackend.closeSession({
          sessionId: openSession.id,
          businessId,
          closedCashAmount: input.monto,
          expectedCashAmount,
          variance,
          closedAt: closeTime,
          closeNote: input.nota ?? null,
          closedByEmployeeId: actorEmployeeId ?? null,
        });
        await completeIdempotentMutation({
          client: prisma,
          recordId,
          responseStatus: 200,
          responseBody: { sessionId: openSession.id, state: "CLOSED", closedCashAmount: input.monto, expectedCashAmount, variance },
        });
      } catch (err) {
        await releaseIdempotentMutation({ client: prisma, recordId });
        throw err;
      }

      await recordCriticalWriteEvent({
        client: prisma,
        businessId,
        actorUserId,
        actorEmployeeId,
        routeScope: "caja/session/close",
        actionType: "caja.session.close",
        resourceType: "caja_session",
        resourceId: openSession.id,
        summary: `Turno de caja cerrado. Contado: $${input.monto}, Esperado: $${expectedCashAmount.toFixed(2)}, Diferencia: $${variance.toFixed(2)}`,
        payload: { sessionId: openSession.id, closed: input.monto, expected: expectedCashAmount, variance },
        before: { state: "OPEN", openedCashAmount: openSession.openedCashAmount },
        after: { state: "CLOSED", closedCashAmount: input.monto, expectedCashAmount, variance },
      });

      const varianceLabel =
        Math.abs(variance) < 0.01
          ? "Sin diferencia."
          : variance < 0
          ? `Faltante de $${Math.abs(variance).toFixed(2)}.`
          : `Sobrante de $${variance.toFixed(2)}.`;

      return {
        sessionId: openSession.id,
        state: "CLOSED",
        closedAt: closed.closedAt?.toISOString() ?? new Date().toISOString(),
        closedCashAmount: input.monto,
        expectedCashAmount,
        variance,
        message: `Turno cerrado. Contado: $${input.monto.toLocaleString("es-AR")} / Esperado: $${expectedCashAmount.toLocaleString("es-AR")}. ${varianceLabel}`,
      };
    },
  });
}
