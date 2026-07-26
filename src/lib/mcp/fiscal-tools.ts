// src/lib/mcp/fiscal-tools.ts — Stateful fiscal MCP tool registrations.
//
// Registers three tenant-scoped tools on a McpServer instance:
//   - get_fiscal_readiness : checks whether the business can emit real ARCA invoices.
//   - emit_invoice         : emits a factura electrónica (real or sandbox).
//   - emit_nota            : emits a NC/ND (Nota Crédito / Débito) against an original invoice.
//
// These tools require a resolved businessId (from the auth gate) and are only
// registered when one is provided. Pure tools (validate_cuit)
// live in server.ts and are always registered regardless of businessId.
//
// Business row fetch pattern mirrors handle-fiscal-rpc.ts:
//   1. One prisma.business.findUnique scoped to businessId.
//   2. Pass the prefetched row into getFiscalReadiness to avoid a double DB round-trip.
//
// emit_invoice / emit_nota do NOT persist an Invoice row. This MCP path is standalone —
// persistCaeAndQr is for the sale-linked ADK path (emit-invoice-tool.ts) only.
//
// The optional `backend` parameter decouples these tools from the Velora implementation.
// Omitting it (the default) selects the active backend via createFiscalBackend() which
// reads FISCAL_BACKEND env (default "velora") — zero behavioural change for existing callers.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TipoComprobante } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/types";
import type { FiscalBackend } from "./_lib/fiscal-backend.port";
import { createFiscalBackend } from "./_lib/fiscal-backend.factory";
import { errResponse } from "./_lib/mcp-responses";

// ── Input schema for emit_invoice ─────────────────────────────────────────────

const EmitInvoiceInputSchema = {
  customerCuit: z
    .string()
    .describe("Customer CUIT/CUIL (11 digits, any format — hyphens and spaces stripped)."),
  amountARS: z.number().positive().describe("Invoice total in Argentine pesos (ARS)."),
  tipo: z
    .enum(["A", "B", "C"])
    .describe(
      "Invoice type per AFIP RG 2485: A = IVA discriminado (B2B), " +
        "B = consumidor final, C = monotributo.",
    ),
  concept: z.string().optional().describe("Items or concept description (optional)."),
  requestId: z
    .string()
    .optional()
    .describe(
      "Optional nonce to distinguish this call from another economically-identical " +
        "emission (same customerCuit/amountARS/tipo) within the same business. Generate " +
        "a fresh value (e.g. a UUID) for each genuinely NEW invoice — omit it, or reuse " +
        "the SAME value, only when retrying an emission you already attempted. Without " +
        "this, two real invoices with identical amounts to the same customer would " +
        "silently collapse into one AFIP emission.",
    ),
};

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers get_fiscal_readiness, emit_invoice, and emit_nota on the given server.
 * Called only when a verified businessId is available from the auth gate.
 *
 * @param backend - Optional FiscalBackend override. Defaults to createFiscalBackend()
 *   which reads FISCAL_BACKEND env (default "velora"). Pass an explicit instance in
 *   tests or when injecting an alternative backend — server.ts call site is unchanged.
 */
export function registerFiscalTools(
  server: McpServer,
  businessId: string,
  backend: FiscalBackend = createFiscalBackend(),
): void {
  // ── Tool: get_fiscal_readiness ─────────────────────────────────────────────
  server.registerTool(
    "get_fiscal_readiness",
    {
      title: "Get fiscal readiness",
      description:
        "Use this before `emit_invoice`/`emit_nota`, or when the owner asks why invoicing is not working — shows which ARCA fields and credentials are missing. " +
        "Checks whether the business is ready to emit real ARCA electronic invoices. " +
        "Returns { ready, missing, guidance } where ready=true means all fiscal fields " +
        "and the ARCA certificate are configured. When ready=false, missing lists what " +
        "is absent and guidance provides step-by-step setup instructions in Spanish. " +
        "guidance is an empty string (not null) when ready=true.",
      inputSchema: {},
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const result = await backend.getFiscalReadiness({ tenantId: businessId });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ── Tool: emit_invoice ─────────────────────────────────────────────────────
  server.registerTool(
    "emit_invoice",
    {
      title: "Emit invoice (ARCA)",
      description:
        "Use this when the owner needs to issue a standalone official electronic invoice (factura electrónica) not linked to an existing sale, OR for a sale recorded via `register_sale` whose customer is a consumidor final (NO CUIT/taxId on file) — those sales do NOT auto-emit to ARCA, so this is the way to produce an official comprobante for them. " +
        "Do NOT call this for a `register_sale` sale whose customer HAS a CUIT/taxId: that sale already triggers the real ARCA emission automatically, and this standalone tool does NOT persist to or dedupe against the sale's Invoice row, so calling it would register a DUPLICATE comprobante with AFIP. " +
        "Emits an ARCA (formerly AFIP)-compliant electronic invoice (factura electrónica) " +
        "for the authenticated business and returns the CAE authorization code. Routes to the " +
        "real ARCA/WSFE pipeline when ARCA_REAL_MODE=true and a credential exists; " +
        "otherwise falls back to sandbox. Does NOT create an Invoice row in Velora's DB — " +
        "this is a standalone emission for MCP callers.",
      inputSchema: EmitInvoiceInputSchema,
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const resolvedConcept = args.concept ?? "Productos y/o servicios";
        const result = await backend.emitInvoice({
          tenantId: businessId,
          customerCuit: args.customerCuit,
          amountARS: args.amountARS,
          tipo: args.tipo,
          concept: resolvedConcept,
          requestId: args.requestId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // #10: surface distinct error codes so callers know whether a retry is safe.
        // EMIT_TRANSPORT_ERROR — retryable only after FECompConsultar confirms no number was consumed.
        // EMIT_AFIP_REJECTED   — permanent; AFIP rejected the request, no number consumed.
        // FISCAL_MISCONFIGURED — misconfiguration; fix credential before retrying.
        // EMIT_IN_FLIGHT       — concurrent emission; retry after a few seconds.
        const code = msg.startsWith("EMIT_TRANSPORT_ERROR") ? "EMIT_TRANSPORT_ERROR"
          : (msg.startsWith("EMIT_AFIP_REJECTED") || msg.includes("FECAESolicitar rechazado")) ? "EMIT_AFIP_REJECTED"
          : msg.startsWith("FISCAL_MISCONFIGURED") ? "FISCAL_MISCONFIGURED"
          : msg.startsWith("EMIT_IN_FLIGHT") ? "EMIT_IN_FLIGHT"
          : "EMIT_FAILED";
        return errResponse(code, msg);
      }
    },
  );

  // ── Tool: emit_nota ────────────────────────────────────────────────────────
  server.registerTool(
    "emit_nota",
    {
      title: "Emit credit/debit note (ARCA)",
      description:
        "Use this when the owner needs to issue a credit note (Nota Crédito, to reduce) or debit note (Nota Débito, to increase) against an EXISTING AFIP invoice. " +
        "Do NOT use this to issue a primary invoice — use `emit_invoice` for that. " +
        "Emits an ARCA-compliant Nota Crédito (NC) or Nota Débito (ND) against an " +
        "original AFIP invoice and returns the CAE authorization code. " +
        "AFIP requires the associated invoice datos (tipo, puntoVenta, nro) — " +
        "emission is rejected without them. Routes to the real ARCA/WSFE pipeline " +
        "when ARCA_REAL_MODE=true and a credential exists; otherwise falls back to sandbox. " +
        "Does NOT create an Invoice row in Velora's DB.",
      inputSchema: {
        customerCuit: z
          .string()
          .describe("Customer CUIT/CUIL (11 digits, any format — hyphens and spaces stripped)."),
        amountARS: z.number().positive().describe("Note total in Argentine pesos (ARS)."),
        tipo: z
          .enum(["A", "B", "C"])
          .describe(
            "Invoice type letter for this nota (A/B/C — auto-corrected for Monotributistas). " +
              "Should match the series of the original invoice.",
          ),
        kind: z
          .enum(["credito", "debito"])
          .describe(
            "Note kind: credito = Nota Crédito (reduces the original invoice amount), " +
              "debito = Nota Débito (increases the original invoice amount).",
          ),
        associatedInvoice: z
          .object({
            // tipo must be the ORIGINAL FACTURA code only: 1=Factura A, 6=Factura B, 11=Factura C.
            // AFIP validates referential integrity server-side — note codes are rejected here.
            tipo: z
              .enum(["1", "6", "11"])
              .describe("WSFE tipoComprobante of the ORIGINAL factura being credited/debited: \"1\"=Factura A, \"6\"=Factura B, \"11\"=Factura C. String enum because Gemini function-calling only supports string enums; converted to a number in the handler. Note codes are not valid here."),
            ptoVta: z.number().int().positive().describe("Punto de venta of the original invoice (1–9999)."),
            nro: z.number().int().positive().describe("Sequential number of the original invoice."),
          })
          .describe("AFIP-required reference to the original invoice being credited or debited."),
        concept: z.string().optional().describe("Items or concept description (optional)."),
        requestId: z
          .string()
          .optional()
          .describe(
            "Optional nonce to distinguish this call from another economically-identical " +
              "nota (same customerCuit/amountARS/tipo/associatedInvoice) — generate a fresh " +
              "value for each genuinely NEW nota, omit or reuse it only when retrying.",
          ),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const resolvedConcept = args.concept ?? "Productos y/o servicios";
        const result = await backend.emitNota({
          tenantId: businessId,
          customerCuit: args.customerCuit,
          amountARS: args.amountARS,
          tipo: args.tipo,
          kind: args.kind,
          // z.enum(["1","6","11"]) guarantees a valid code; Number() converts the
          // Gemini-compatible string enum back to the numeric WSFE TipoComprobante.
          cbteAsoc: {
            tipo: Number(args.associatedInvoice.tipo) as TipoComprobante,
            ptoVta: args.associatedInvoice.ptoVta,
            nro: args.associatedInvoice.nro,
          },
          concept: resolvedConcept,
          requestId: args.requestId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = msg.startsWith("EMIT_TRANSPORT_ERROR") ? "EMIT_TRANSPORT_ERROR"
          : (msg.startsWith("EMIT_AFIP_REJECTED") || msg.includes("FECAESolicitar rechazado")) ? "EMIT_AFIP_REJECTED"
          : msg.startsWith("FISCAL_MISCONFIGURED") ? "FISCAL_MISCONFIGURED"
          : msg.startsWith("EMIT_IN_FLIGHT") ? "EMIT_IN_FLIGHT"
          : "EMIT_FAILED";
        return errResponse(code, msg);
      }
    },
  );
}
