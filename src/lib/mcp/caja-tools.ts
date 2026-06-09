import "server-only";
// src/lib/mcp/caja-tools.ts — Stateful caja (cash register) MCP tool registrations.
//
// Registers three tenant-scoped tools on a McpServer instance:
//   - caja_consultar_saldo     : read current cash balance (open session or last closed).
//   - caja_ciclo_caja          : open or close a cash shift.
//   - caja_registrar_movimiento: record a cash movement (income, expense, withdrawal…).
//
// SECURITY:
//   businessId ALWAYS comes from the auth-gate closure — never from tool input.
//   Idempotency keys are derived server-side from (requestId, toolName, sortedInput).
//   The caller CANNOT supply or influence the idempotency key.
//
// MONEY PATH — do NOT relax:
//   caja_ciclo_caja and caja_registrar_movimiento use the full mutation contract:
//     beginIdempotentMutation → DB write → completeIdempotentMutation
//     recordCriticalWriteEvent (financial event)
//   Mutation handlers live in ./_lib/caja-mutations.ts (LOC split).
//   caja_consultar_saldo is read-only — no idempotency needed.
//
// Idempotency key derivation (MCP context):
//   MCP requests do not carry an ADK turnId. We derive the key from:
//     SHA-256(requestId | toolName | JSON.stringify(sortedInput)).slice(0, 32)
//   requestId is a per-request UUID generated once and shared across all three tools.
//   This matches the deriveServerKey contract from caja-ciclo-tool.ts (Part A).
//
// References:
//   Square CashDrawerShift — https://developer.squareup.com/reference/square/objects/CashDrawerShift
//   CajaBackend port       — src/lib/mcp/_lib/caja-backend.port.ts
//   Mutation handlers      — src/lib/mcp/_lib/caja-mutations.ts
//   ADK caja-ciclo-tool.ts — mirrors the mutation contract used there

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash, randomUUID } from "crypto";
import type { CajaBackend } from "./_lib/caja-backend.port";
import { createCajaBackend } from "./_lib/caja-backend.factory";
import {
  handleCicloCajaAbrir,
  handleCicloCajaCerrar,
  handleRegistrarMovimiento,
} from "./_lib/caja-mutations";

// ── Idempotency key derivation ────────────────────────────────────────────────

function deriveMcpCajaKey(requestId: string, toolName: string, input: object): string {
  const canonical = [requestId, toolName, JSON.stringify(input, Object.keys(input).sort())].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers caja_consultar_saldo, caja_ciclo_caja, and caja_registrar_movimiento
 * on the given McpServer. Called only when a verified businessId is available.
 *
 * @param backend Optional CajaBackend override for tests. Defaults to createCajaBackend()
 *   which reads CAJA_BACKEND env (default "velora").
 */
export function registerCajaTools(
  server: McpServer,
  businessId: string,
  backend: CajaBackend = createCajaBackend(),
): void {
  // One requestId per registration — shared across all tools for this request.
  const requestId = randomUUID();

  // ── Tool: caja_consultar_saldo ────────────────────────────────────────────
  server.registerTool(
    "caja_consultar_saldo",
    {
      title: "Consult cash balance",
      description:
        "Use this when the owner asks how much cash is in the register or what the current shift balance is. " +
        "Queries the current cash register balance for the authenticated business. " +
        "Returns the open session data (opened amount + movements = expected cash) " +
        "or the last closed session when no shift is currently open. Read-only.",
      inputSchema: {},
      // Standard MCP tool annotations — https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const openSession = await backend.findOpenSessionWithAmount(businessId);

      if (!openSession) {
        const lastClosed = await backend.findLastClosedSession(businessId);
        if (!lastClosed) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ state: "NO_SESSION", message: "No open shift and no prior history for this business." }),
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              state: "CLOSED",
              sessionId: lastClosed.id,
              closedAt: lastClosed.closedAt,
              closedCashAmount: lastClosed.closedCashAmount,
              variance: lastClosed.variance,
            }),
          }],
        };
      }

      const movements = await backend.findCashMovementsForSession({ businessId, fromDate: openSession.openedAt });
      const totalInflows = movements.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0);
      const totalOutflows = movements.filter((m) => m.amount < 0).reduce((s, m) => s + m.amount, 0);
      const expectedCashAmount = openSession.openedCashAmount + totalInflows + totalOutflows;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            state: "OPEN",
            sessionId: openSession.id,
            openedAt: openSession.openedAt.toISOString(),
            openedCashAmount: openSession.openedCashAmount,
            totalInflows,
            totalOutflows: Math.abs(totalOutflows),
            expectedCashAmount,
            movementCount: movements.length,
          }),
        }],
      };
    },
  );

  // ── Tool: caja_ciclo_caja ─────────────────────────────────────────────────
  server.registerTool(
    "caja_ciclo_caja",
    {
      title: "Open or close cash shift",
      description:
        "Use this when the owner wants to open or close a cash register shift. " +
        "Opens or closes a cash register shift for the authenticated business. " +
        "action='abrir': records the opening float (monto). " +
        "action='cerrar': records physically counted cash, computes expected amount " +
        "from movements, and stores the variance. " +
        "Only one shift can be open at a time. " +
        "EXECUTES IMMEDIATELY on each call. The idempotency key is server-derived " +
        "per HTTP request — a network-layer retry regenerates the key and will " +
        "attempt a second mutation (non-idempotent across retries). For 'abrir', an " +
        "application-level open-shift guard rejects a duplicate open, making it safer; " +
        "for 'cerrar', a retry after a successful close returns isError with code " +
        "NO_OPEN_SESSION — that confirms the close succeeded. " +
        "MCP transport is stateless: the CALLER owns retry idempotency. " +
        "Returns isError: true when a shift is already open (abrir) or missing (cerrar).",
      inputSchema: {
        action: z.enum(["abrir", "cerrar"]).describe("'abrir' to open a shift, 'cerrar' to close it."),
        monto: z.number().finite().min(0).describe("Opening float (abrir) or physically counted cash (cerrar) in ARS."),
        nota: z.string().max(500).optional().describe("Optional operator note."),
      },
      // Standard MCP tool annotations — https://modelcontextprotocol.io/specification/2025-06-18/schema
      // destructiveHint: true — opens/closes a real cash shift; irreversible financial record.
      // idempotentHint: false — the idempotency key is derived per-request (same derivation as
      // caja_registrar_movimiento). A network-layer retry generates a NEW key and can create a
      // second shift open/close. The open-shift guard makes 'abrir' retries safer in practice,
      // but the contract is non-idempotent and must be flagged honestly.
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      const derivedKey = deriveMcpCajaKey(requestId, "caja_ciclo_caja", {
        action: args.action,
        monto: args.monto,
        ...(args.nota !== undefined ? { nota: args.nota } : {}),
      });
      if (args.action === "abrir") {
        return handleCicloCajaAbrir(businessId, backend, derivedKey, args.monto, args.nota);
      }
      return handleCicloCajaCerrar(businessId, backend, derivedKey, args.monto, args.nota);
    },
  );

  // ── Tool: caja_registrar_movimiento ───────────────────────────────────────
  server.registerTool(
    "caja_registrar_movimiento",
    {
      title: "Register cash movement (caja)",
      description:
        "Use this when the owner wants to record a cash movement such as paying a supplier, a salary, a tax, or a miscellaneous income/expense. " +
        "This entry is tied to the OPEN caja shift. For a general ledger entry not tied to a shift, use `register_movement` (sales pack) instead. " +
        "Records a cash movement: income (ingreso), expense (gasto), " +
        "withdrawal/sangría (retiro/sangria), tax (impuesto), or payroll (sueldo). " +
        "Pass a positive monto — the server applies the correct accounting sign. " +
        "EXECUTES IMMEDIATELY on each call. The idempotency key is server-derived " +
        "per HTTP request — a network-layer retry regenerates the key and MAY " +
        "create a duplicate cash movement. " +
        "Do NOT retry after a network error without first calling caja_consultar_saldo " +
        "to confirm no movement was created. Same-HTTP-request retries are safe (idempotent); " +
        "cross-request retries are NOT. " +
        "Returns the stored movement id, domain type, and signed amount.",
      inputSchema: {
        tipo: z
          .enum(["ingreso", "gasto", "retiro", "sangria", "sangría", "impuesto", "sueldo"])
          .describe("Movement type. 'retiro'/'sangria' = cash withdrawal from register."),
        monto: z.number().finite().positive().describe("Positive amount in ARS. Sign applied by the server."),
        descripcion: z.string().min(1).max(500).describe("Movement description (e.g. 'Electric bill payment')."),
      },
      // Standard MCP tool annotations — https://modelcontextprotocol.io/specification/2025-06-18/schema
      // idempotentHint FALSE: a cross-request retry can create a duplicate cash movement (honest).
      // destructiveHint: true — creates an irreversible cash movement record; cross-request retries may double-create.
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      const derivedKey = deriveMcpCajaKey(requestId, "caja_registrar_movimiento", {
        tipo: args.tipo,
        monto: args.monto,
        descripcion: args.descripcion,
      });
      return handleRegistrarMovimiento(businessId, backend, derivedKey, args.tipo, args.monto, args.descripcion);
    },
  );
}
