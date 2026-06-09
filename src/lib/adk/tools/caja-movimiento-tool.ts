import "server-only";
// caja-movimiento-tool.ts — caja.registrar_movimiento: cash-in / cash-out.
//
// Source: Square CashDrawerShiftEvent (verified HTTP 200 2026-06-02)
//   https://developer.squareup.com/reference/square/enums/CashDrawerEventType
//   PAID_IN = ingreso extra; PAID_OUT = gasto / retiro / sangría
//   Toast equivalent: CASH_IN | CASH_OUT | PAY_OUT
//
// Fix: "retiro" (sangría) previously mapped to "adjustment", corrupting caja
// reports by mixing intentional cash-out events with generic balance corrections.
// Now maps to the distinct "withdrawal" type (stored negative like "purchase").
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

// Map Spanish movement type labels to the domain CashMovementType values.
const TIPO_ES_TO_DOMAIN: Record<string, string> = {
  ingreso: "income",
  gasto: "purchase",
  retiro: "withdrawal",
  sangria: "withdrawal",
  // C6: accept accented form — the LLM (and users) naturally write "sangría"
  // with tilde; the unaccented alias above covers the fallback.
  "sangría": "withdrawal",
  impuesto: "tax",
  sueldo: "salary",
};

const TIPO_LABEL: Record<string, string> = {
  income: "Ingreso",
  purchase: "Gasto",
  withdrawal: "Retiro / Sangría",
  tax: "Impuesto",
  salary: "Sueldo",
};

const RegistrarMovimientoInput = z.object({
  // C6: include accented "sangría" so Zod doesn't reject LLM output that uses
  // the natural Spanish spelling. Both aliases map to "withdrawal" in TIPO_ES_TO_DOMAIN.
  tipo: z.enum(
    ["ingreso", "gasto", "retiro", "sangria", "sangría", "impuesto", "sueldo"],
    { errorMap: () => ({ message: "Tipo inválido. Usá: ingreso, gasto, retiro, impuesto, sueldo." }) }
  ),
  monto: z
    .number()
    .finite()
    .positive("El monto debe ser mayor a 0.")
    .describe("Monto positivo del movimiento. El sistema aplica el signo correcto según el tipo."),
  descripcion: z
    .string()
    .min(1, "La descripción es obligatoria.")
    .max(500)
    .describe("Descripción del movimiento (ej: 'Pago luz', 'Sangría apertura turno')."),
});

const REGISTRAR_MOVIMIENTO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    tipo: {
      type: Type.STRING,
      description:
        "Tipo de movimiento: 'ingreso' (entrada de efectivo), 'gasto' (salida por compra/gasto), " +
        "'retiro' o 'sangria' (extracción de efectivo de la caja = sangría), " +
        "'impuesto' (pago de impuesto desde caja), 'sueldo' (pago de salario).",
    },
    monto: {
      type: Type.NUMBER,
      description: "Monto positivo. El sistema aplica el signo contable correcto según el tipo.",
    },
    descripcion: {
      type: Type.STRING,
      description: "Descripción breve del movimiento (ej: 'Pago servicio luz', 'Sangría apertura turno').",
    },
  },
  required: ["tipo", "monto", "descripcion"],
};

export function createRegistrarMovimientoTool(backend: CajaToolsBackend) {
  return createTool({
    name: "caja.registrar_movimiento",
    description:
      "Registra un movimiento de efectivo en la caja: ingreso extra, gasto, retiro (sangría), " +
      "impuesto o sueldo. Los retiros y sangrías se registran como tipo 'withdrawal' " +
      "(distinto de ajuste) para que el reporte de caja los categorice correctamente. " +
      "Siempre pide confirmación al usuario antes de llamar este tool.",
    schema: REGISTRAR_MOVIMIENTO_SCHEMA,
    inputSchema: RegistrarMovimientoInput,
    backend,
    // Part A: server-derived idempotency — LLM cannot influence the key.
    // Key = SHA-256(turnId | "caja.registrar_movimiento" | canonical(input)).slice(0,32)
    // turnId is the RPC contextId threaded from handle-caja-rpc.ts (stable per request).
    turnIdempotency: {
      turnId: serverTurnId(backend.turnId),
      businessId: backend.businessId,
      actionType: "caja.movement.create",
    },
    execute: async ({ input, backend: b, idempotency }) => {
      const { businessId, actorUserId, actorEmployeeId } = b;
      const cajaBackend = createCajaBackend();

      const domainType = TIPO_ES_TO_DOMAIN[input.tipo];
      if (!domainType) {
        return { error: { code: "INVALID_TYPE", message: `Tipo de movimiento no reconocido: ${input.tipo}` } };
      }

      // idempotency.key is server-derived — never LLM-supplied.
      const derivedKey = idempotency!.key;

      const idem = await beginIdempotentMutation({
        client: prisma,
        businessId,
        actionType: "caja.movement.create",
        idempotencyKey: derivedKey,
        requestBody: { tipo: input.tipo, monto: input.monto, descripcion: input.descripcion },
      });
      if (idem.kind === "replay") {
        const replayBody = await (idem.response as Response).json().catch(() => null);
        return replayBody ?? { replayed: true, message: "Movimiento ya registrado." };
      }
      if (idem.kind !== "execute") {
        return { error: { code: "IDEMPOTENCY_CONFLICT", message: "Conflicto de idempotencia. Reintentá." } };
      }
      const { recordId } = idem;

      let movementId: string;
      let storedAmount: number;
      try {
        const created = await cajaBackend.createMovement({
          businessId,
          domainType,
          description: input.descripcion,
          amount: input.monto,
          // clientMessageId uses the server-derived key so CashMovement dedup
          // is aligned with the IdempotentMutation record — no drift possible.
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
        actorUserId,
        actorEmployeeId,
        routeScope: "caja/movements",
        actionType: "caja.movement.create",
        resourceType: "cash_movement",
        resourceId: movementId,
        summary: `Movimiento de caja: ${input.tipo} $${input.monto} — ${input.descripcion}`,
        payload: { movementId, tipo: input.tipo, domainType, monto: input.monto, descripcion: input.descripcion },
        after: { movementId, type: domainType, amount: storedAmount },
      });

      return {
        movementId,
        type: domainType,
        amount: storedAmount,
        descripcion: input.descripcion,
        message: `${TIPO_LABEL[domainType] ?? domainType} de $${input.monto.toLocaleString("es-AR")} registrado: ${input.descripcion}.`,
      };
    },
  });
}
