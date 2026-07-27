// src/lib/mcp/_lib/caja-status-render.ts — open_caja_status render tool + resource.
//
// Extracted as a standalone file to stay under the 300-line file-size limit.
// Contains:
//   - registerCajaStatusRenderTool() — registers the resource + render tool on an McpServer
//
// Tenant isolation: businessId ALWAYS comes from the closure parameter — never from tool input.
//
// READ-ONLY: this tool resolves current shift data and pre-fills the caja-status widget.
// Mutations (abrir/cerrar) are fired from the widget via callServerTool → caja_ciclo_caja.
// caja_ciclo_caja owns all idempotency, audit, and financial guards.
//
// Data resolved: open session amount + movements (expected cash) or last closed session.
// Mirrors caja_consultar_saldo resolution logic (no duplication of mutation paths).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { CajaBackend } from "./caja-backend.port";
import { CAJA_STATUS_HTML } from "../widgets/generated/caja-status.html";
import { nextSeq } from "./election-seq";

/** Canonical ui:// URI for the caja-status widget resource. */
export const CAJA_STATUS_RESOURCE_URI = "ui://caja-status";

// ── Types ─────────────────────────────────────────────────────────────────────

type CajaState = "OPEN" | "CLOSED" | "NO_SESSION";

export interface CajaMovementItem {
  type: string;
  description: string;
  amount: number;
  date: string;
}

// Same cap convention as pending-orders.tsx's DISPLAY_CAP.
const MOVEMENTS_CAP = 10;

export interface CajaPrefill {
  state: CajaState;
  /** Defined when state=OPEN */
  sessionId?: string;
  openedAt?: string;
  openedCashAmount?: number;
  totalInflows?: number;
  totalOutflows?: number;
  expectedCashAmount?: number;
  movementCount?: number;
  // JD integration-map finding (2026-07-26): the owner could see the blended
  // Ingresos/Egresos total but never WHICH lines made it up (sale vs. manual
  // movement) without leaving the widget — data was already unified in one
  // CashMovement query, just discarded before reaching the prefill. Capped +
  // newest-first (same query already orders desc). Optional: business-overview
  // reuses this resolver too and doesn't render the list, only the totals.
  movements?: CajaMovementItem[];
  /** Defined when state=CLOSED */
  closedAt?: string | null;
  closedCashAmount?: number | null;
  variance?: number | null;
}

// ── Resolution ────────────────────────────────────────────────────────────────
//
// Exported so other render tools (e.g. open_business_overview) can reuse the exact
// same balance-resolution logic instead of duplicating it — see business-overview-render.ts.
export async function resolveCajaPrefill(businessId: string, backend: CajaBackend): Promise<CajaPrefill> {
  const openSession = await backend.findOpenSessionWithAmount(businessId);

  if (!openSession) {
    const lastClosed = await backend.findLastClosedSession(businessId);
    if (!lastClosed) {
      return { state: "NO_SESSION" };
    }
    return {
      state: "CLOSED",
      sessionId: lastClosed.id,
      closedAt: lastClosed.closedAt,
      closedCashAmount: lastClosed.closedCashAmount,
      variance: lastClosed.variance,
    };
  }

  const movements = await backend.findCashMovementsForSession({ businessId, fromDate: openSession.openedAt });
  const totalInflows = movements.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0);
  const totalOutflows = movements.filter((m) => m.amount < 0).reduce((s, m) => s + m.amount, 0);
  const expectedCashAmount = openSession.openedCashAmount + totalInflows + totalOutflows;

  return {
    state: "OPEN",
    sessionId: openSession.id,
    openedAt: openSession.openedAt.toISOString(),
    openedCashAmount: openSession.openedCashAmount,
    totalInflows,
    totalOutflows: Math.abs(totalOutflows),
    expectedCashAmount,
    movementCount: movements.length,
    movements: movements.slice(0, MOVEMENTS_CAP).map((m) => ({
      type: m.type ?? "movimiento",
      description: m.description ?? "",
      amount: m.amount,
      date: m.date ?? openSession.openedAt.toISOString(),
    })),
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the ui://caja-status resource and the open_caja_status render tool
 * on the given server.
 *
 * READ-ONLY: resolves current shift data and pre-fills the widget.
 * Action buttons in the widget (Abrir / Cerrar caja) fire caja_ciclo_caja
 * via callServerTool — that tool owns all mutation guards.
 *
 * businessId comes from the closure — never from tool input (tenant isolation).
 */
export function registerCajaStatusRenderTool(
  server: McpServer,
  businessId: string,
  backend: CajaBackend,
): void {
  // Resource: self-contained HTML widget (bundled by build-widget.mjs).
  registerAppResource(
    server,
    "Estado de caja",
    CAJA_STATUS_RESOURCE_URI,
    { _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: CAJA_STATUS_HTML }],
    }),
  );

  // Render tool: fetch current shift state, pre-fill widget.
  registerAppTool(
    server,
    "open_caja_status",
    {
      title: "Open caja status",
      description:
        "Use this when the owner wants a VISUAL view of the current cash register state. " +
        "For raw JSON balance without a widget, use `caja_consultar_saldo` instead. " +
        "Opens the caja status widget — shows the current balance (expected cash), " +
        "shift state (abierta / cerrada), opening float, inflows, outflows, and " +
        "action buttons to open or close the shift. " +
        "Side-effect-free — READ-ONLY. Mutations fire from the widget via caja_ciclo_caja.",
      _meta: {
        ui: { resourceUri: CAJA_STATUS_RESOURCE_URI },
        "openai/outputTemplate": CAJA_STATUS_RESOURCE_URI,
      },
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const cajaPrefill = await resolveCajaPrefill(businessId, backend);
        // Election key for widget instance supersession (claude.com/docs/connectors/
        // building/mcp-apps/instance-supersession) — added here, not inside
        // resolveCajaPrefill, since that resolver is shared with business-overview
        // and stays a pure data fetch. seq tie-breaks createdAt ties (same-ms calls).
        const prefill = { ...cajaPrefill, createdAt: Date.now(), seq: nextSeq() };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(prefill) }],
          structuredContent: { prefill },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ code: "CAJA_STATUS_ERROR", message }) }],
          isError: true,
        };
      }
    },
  );
}
