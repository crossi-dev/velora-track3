// emit-invoice-tool.ts — ADK FunctionTool factory for emit_invoice.
//
// Wraps the arcaEmit router (arca-real/emit-invoice.ts) and normalises
// its return shape to a stable contract for the ADK agent.
// After a successful real (non-sandbox) WSFE call, writes the CAE fields
// back to the Invoice row so they are persisted per AFIP RG 2485 requirements.
//
// Types split into emit-invoice-tool.types.ts (300-line limit).

import { FunctionTool } from "@google/adk";
import { cloudLog } from "@/lib/cloud-logger";
import { emit as arcaEmit } from "./arca-real/emit-invoice";
import type { EmitResult } from "./arca-real/emit-invoice";
import { persistCaeAndQr } from "./emit-invoice-tool.cae-persist";
import { createFiscalBackend } from "@/lib/mcp/_lib/fiscal-backend.factory";

export {
  emitInvoiceParams,
  type EmitInvoiceInput,
  type EmitInvoiceToolResult,
  type EmitInvoiceToolContext,
} from "./emit-invoice-tool.types";

import type {
  EmitInvoiceInput,
  EmitInvoiceToolResult,
  EmitInvoiceToolContext,
} from "./emit-invoice-tool.types";
import { emitInvoiceParams } from "./emit-invoice-tool.types";

// ── Normalised result mapper ──────────────────────────────────────────────────

export function normaliseEmitResult(
  raw: EmitResult,
  customerCuit: string,
  amountARS: number,
  concept: string,
): EmitInvoiceToolResult {
  if (raw.sandbox) {
    // SandboxInvoiceResult — tipo is already corrected by sandboxEmit (resolveInvoiceType).
    const base: EmitInvoiceToolResult = {
      sandbox: true,
      cae: raw.cae,
      vencimiento: raw.vencimiento,
      tipo: raw.tipo,
      numero: raw.numero,
      customerCuit,
      amountARS,
      concept,
    };
    // C-2: when ARCA_REAL_MODE=true but the ArcaCredential was deleted, emit-invoice.ts
    // returns { ...sandboxEmit(...), misconfigured: true }. Without this check the flag
    // is dropped here and the owner gets "emitido en SANDBOX" with no explanation.
    // Surface setupGuidance so the LLM tells the owner to reconnect ARCA.
    if (raw.misconfigured) {
      base.setupGuidance =
        "La credencial ARCA fue eliminada o no está configurada. " +
        "El modo real está activo (ARCA_REAL_MODE=true) pero no hay credencial para este negocio. " +
        "El owner debe reconectar el certificado ARCA desde Ajustes → Fiscal antes de emitir facturas reales.";
    }
    return base;
  }
  // EmitInvoiceResult (real) — remap vencimientoCae → vencimiento for stable contract.
  // Reverse-map WSFE tipoComprobante to the invoice letter for the agent contract.
  // Covers Facturas (1/6/11) and NC/ND types (2/3/7/8/12/13) added in Phase 3.
  const tipoMap: Record<number, "A" | "B" | "C"> = {
    1: "A", 2: "A", 3: "A",   // Factura A, ND A, NC A
    6: "B", 7: "B", 8: "B",   // Factura B, ND B, NC B
    11: "C", 12: "C", 13: "C", // Factura C, ND C, NC C
  };
  const tipoLetter = tipoMap[raw.tipoComprobante];
  if (!tipoLetter) {
    // Unknown AFIP tipoComprobante code — log loudly; never silently mislabel as "C".
    cloudLog({
      severity: "ERROR",
      component: "Fiscal",
      action: "EMIT_INVOICE_UNKNOWN_TIPO",
      a2a_transfer: false,
      message: `AFIP returned unknown tipoComprobante=${raw.tipoComprobante} — cannot map to A/B/C`,
      data: { tipoComprobante: raw.tipoComprobante, cae: raw.cae },
    });
  }
  return {
    sandbox: false,
    cae: raw.cae,
    vencimiento: raw.vencimientoCae,
    tipo: tipoLetter ?? `UNKNOWN:${raw.tipoComprobante}`,
    numero: raw.numero,
    customerCuit,
    amountARS,
    concept,
  };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Builds the emit_invoice FunctionTool closed over the request-scoped businessId.
 *
 * Routing (evaluated at call time — reads env at execute() time, not module-load):
 *   1. toolCtx.backendOverride present → use it (test injection, bypasses flag).
 *   2. USE_MCP_FISCAL_TOOL=true OR AGENT_FISCAL_BACKEND set (non-blank) → route through
 *      createFiscalBackend() which wires VeloraFiscalAdapter with idempotency +
 *      per-tenant routing. USE_MCP_FISCAL_TOOL is the canonical boolean gate (default OFF);
 *      AGENT_FISCAL_BACKEND is the legacy string gate kept for backward compat.
 *   3. Both unset / false → legacy arcaEmit direct call (default — safe for demo/prod).
 *
 * LEGAL/REGULATED PATH: ARCA/AFIP invoice emission is non-idempotent. The flag MUST
 * default OFF so all existing paths (demo, prod) run the unchanged arcaEmit path.
 * Flip USE_MCP_FISCAL_TOOL=true ONLY after confirming the adapter's idempotency layer
 * and Resultado!="A" hard-stop are exercised end-to-end in a non-prod environment.
 */
export function buildEmitInvoiceTool(
  ctx: { businessId: string | null },
  toolCtx: EmitInvoiceToolContext,
): FunctionTool {
  return new FunctionTool({
    name: "emit_invoice",
    description:
      "Emits an ARCA-compliant electronic invoice (factura electrónica) and returns the CAE " +
      "authorization code. Routes to the real ARCA pipeline when ARCA_REAL_MODE is active; " +
      "otherwise falls back to sandbox.",
    parameters: emitInvoiceParams,
    execute: async (input): Promise<EmitInvoiceToolResult> => {
      const { customerCuit, amountARS, tipo, concept } =
        input as EmitInvoiceInput;
      const resolvedConcept = concept ?? "Productos y/o servicios";

      // C-1: businessId is required for tenant-scoped emission. An empty string
      // reaches loadCredential("") → null → silent sandbox fallback with a
      // misleading misconfiguration alert. Hard-fail instead — no invoice without tenant.
      if (!ctx.businessId) {
        throw new Error(
          "EMIT_REQUIRES_BUSINESS_ID: fiscal tool called without a tenant",
        );
      }
      const businessId = ctx.businessId;

      let result: EmitInvoiceToolResult;

      // Priority: backendOverride > USE_MCP_FISCAL_TOOL / AGENT_FISCAL_BACKEND > null (legacy).
      // Read at call time (not module-load) so feature flags can be toggled without reload.
      // USE_MCP_FISCAL_TOOL=true is the canonical boolean gate (default OFF — strangler-fig).
      // AGENT_FISCAL_BACKEND="velora" is the legacy string gate kept for backward compat.
      // Either flag being active routes to createFiscalBackend(backendSlug).
      const useMcpFiscalTool = process.env.USE_MCP_FISCAL_TOOL === "true";
      const agentFiscalBackend = (process.env.AGENT_FISCAL_BACKEND ?? "").trim();
      // When USE_MCP_FISCAL_TOOL=true and no explicit AGENT_FISCAL_BACKEND slug is given,
      // default to "velora" (the only supported backend). This keeps the flag surface minimal.
      const backendSlug = agentFiscalBackend || (useMcpFiscalTool ? "velora" : "");
      const backend =
        toolCtx.backendOverride ??
        (backendSlug ? createFiscalBackend(backendSlug) : null);

      if (backend !== null) {
        // ── BACKEND PATH (USE_MCP_FISCAL_TOOL=true / AGENT_FISCAL_BACKEND set / backendOverride) ─
        // Adapter populates _raw with {tipoComprobante, puntoVenta} so we can call
        // persistCaeAndQr as the legacy path does. replayed:true = already persisted.
        const backendResult = await backend.emitInvoice({
          tenantId: businessId,
          customerCuit,
          amountARS,
          tipo,
          concept: resolvedConcept,
        });
        type BackendResultInternal = EmitInvoiceToolResult & { replayed?: true };
        const { _raw: backendRaw, replayed: isReplay, ...backendResultClean } = backendResult as BackendResultInternal;
        result = backendResultClean;
        if (result.sandbox) toolCtx.sandboxUsed = true;

        if (!result.sandbox && toolCtx.invoiceId && !isReplay && backendRaw) {
          const syntheticRaw: import("./arca-real/emit-invoice").EmitResult = {
            sandbox: false,
            cae: result.cae,
            vencimientoCae: result.vencimiento ?? "",
            tipoComprobante: backendRaw.tipoComprobante as import("./arca-real/types").TipoComprobante,
            puntoVenta: backendRaw.puntoVenta,
            numero: result.numero,
            // M-1 FIX: persistCaeAndQr sets fiscalEmittedAt independently; issuedAt is unused.
            issuedAt: "",
          };
          await persistCaeAndQr({
            businessId,
            invoiceId: toolCtx.invoiceId,
            businessCuit: toolCtx.businessCuit ?? null,
            invoiceDate: toolCtx.invoiceDate ?? null,
            customerCuit,
            amountARS,
            raw: syntheticRaw,
            resultCae: result.cae,
            resultNumero: result.numero,
            resultTipo: result.tipo,
            resultVencimiento: result.vencimiento ?? "",
          });
        }
      } else {
        // ── LEGACY PATH (flag OFF — default) ─────────────────────────────────
        // H-3: WSFE/WSAA SOAP faults propagate from execute() → ADK FunctionTool
        // runAsync re-throws them (verified: node_modules/@google/adk/dist/cjs/tools/
        // function_tool.js L89-103 — catch wraps and re-throws, does NOT swallow).
        // runRpcAgent's outer catch surfaces the throw as a hard RPC error —
        // no fake CAE can ever emerge from this path.
        const raw = await arcaEmit({
          businessId,
          customerCuit,
          amountARS,
          tipo,
          concept: resolvedConcept,
          condicionIva: toolCtx.businessCondicionIva,
        });
        result = normaliseEmitResult(raw, customerCuit, amountARS, resolvedConcept);
        if (result.sandbox) toolCtx.sandboxUsed = true;

        // Persist CAE fields back to the Invoice row after a successful real emission.
        // Sandbox results carry no legal CAE — excluded inside the helper guard.
        if (!result.sandbox && toolCtx.invoiceId) {
          await persistCaeAndQr({
            businessId,
            invoiceId: toolCtx.invoiceId,
            businessCuit: toolCtx.businessCuit ?? null,
            invoiceDate: toolCtx.invoiceDate ?? null,
            customerCuit,
            amountARS,
            raw,
            resultCae: result.cae,
            resultNumero: result.numero,
            resultTipo: result.tipo,
            resultVencimiento: result.vencimiento ?? "",
          });
        }
      }

      // F-2: surface readiness guidance if not yet set up for real invoicing.
      // C-2's specific setupGuidance (credential deleted) wins over the generic
      // readiness guidance — only fill with readiness when C-2 didn't set one.
      if (toolCtx.readiness && !toolCtx.readiness.ready) {
        return { ...result, setupGuidance: result.setupGuidance ?? toolCtx.readiness.guidance };
      }
      return result;
    },
  });
}
