// Fiscal RPC handler — thin dispatcher over fiscal-agent.ts.
// ADK Agent setup → fiscal-agent.ts
// Shared JSON-RPC wire types → @/lib/a2a/jsonrpc-types

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type A2APart,
  RPC_ERRORS,
  rpcError,
  rpcResult,
  extractTextFromParams,
  extractContextIdFromParams,
  extractBusinessIdFromText,
  extractInvoiceIdFromText,
  extractInvoiceDateFromText,
} from "@velora/core-utils/jsonrpc-types";
import { createFiscalAgent, type BusinessFiscalProfile } from "./fiscal-agent";
import type { EmitInvoiceToolContext } from "./emit-invoice-tool";
import { getFiscalReadiness } from "./fiscal-readiness";
import { handleRpcRunnerError, logRpcAgentEmptyDrain } from "@/app/api/agents/_lib/rpc-runner-obs";
import { runRpcAgent } from "@/app/api/agents/_lib/run-rpc-agent";

export type { JsonRpcRequest, JsonRpcResponse };
export { RPC_ERRORS, rpcError, extractTextFromParams, extractBusinessIdFromText, extractInvoiceIdFromText, extractInvoiceDateFromText };

// ADK runner timeout — env-overridable so Cloud Run can tune without a redeploy.
// Default 40s: WSAA+WSFE dual SOAP can each take ~10s → 20s total + Gemini reasoning.
// Outer A2A client (CONTADOR_AGENT_TIMEOUT_MS) = 52s = inner 40s + 12s margin.
// Source: Google SRE Book — Deadline Propagation (Addressing Cascading Failures)
// https://sre.google/sre-book/addressing-cascading-failures/
const FISCAL_ADK_TIMEOUT_MS = Number(process.env.FISCAL_ADK_TIMEOUT_MS ?? "40000");

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleFiscalRpc(
  body: JsonRpcRequest,
  ctx?: { businessId?: string | null; invoiceId?: string | null; invoiceDate?: string | null },
): Promise<JsonRpcResponse> {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST);
  }

  switch (body.method) {
    case "message/send": {
      const text = extractTextFromParams(body.params);
      if (!text) {
        return rpcError(
          body.id,
          RPC_ERRORS.INVALID_PARAMS,
          "message.parts must contain at least one text part",
        );
      }

      const contextId = extractContextIdFromParams(body.params) ?? randomUUID();

      // F-1: load business fiscal profile so the agent knows CUIT / IVA condition / punto de venta.
      // F-2: pre-check readiness so the tool can relay accurate setup guidance.
      const businessId = ctx?.businessId ?? null;
      let fiscalProfile: BusinessFiscalProfile | null = null;
      const toolCtx: EmitInvoiceToolContext = {
        sandboxUsed: false,
        invoiceId: ctx?.invoiceId ?? null,
        // Prefer ctx-injected date (direct callers like sale-post-commit); fall
        // back to text extraction for A2A callers (trigger-fiscal-receipt) who
        // embed "invoiceDate: YYYY-MM-DD" in the message header.
        invoiceDate:
          ctx?.invoiceDate ??
          (extractTextFromParams(body.params)
            ? extractInvoiceDateFromText(extractTextFromParams(body.params)!)
            : null) ??
          null,
      };

      if (businessId) {
        try {
          // Load the business row once and pass it into getFiscalReadiness so the
          // function can skip its own Business.findUnique (eliminates double DB query).
          const businessRow = await prisma.business.findUnique({
            where: { id: businessId },
            select: { cuit: true, ivaCondition: true, puntoVenta: true },
          });
          const readiness = await getFiscalReadiness(businessId, businessRow);

          if (businessRow) {
            fiscalProfile = {
              cuit: businessRow.cuit ?? null,
              ivaCondition: businessRow.ivaCondition ?? null,
              puntoVenta: businessRow.puntoVenta ?? null,
              arcaReady: readiness.ready,
            };
            // F-3: pass IVA condition through so sandboxEmit applies the same type correction.
            toolCtx.businessCondicionIva = businessRow.ivaCondition ?? null;
            // QR-1: pass CUIT so emit_invoice can build the RG 4291 QR URL after CAE emission.
            toolCtx.businessCuit = businessRow.cuit ?? null;
          }
          // F-2: wire readiness into the tool context so emit_invoice can surface guidance.
          toolCtx.readiness = readiness;
        } catch (profileError) {
          // L-1: DB failure while loading fiscal profile — degrade gracefully.
          // The agent proceeds with null profile (no system-prompt enrichment) and
          // unknown readiness (tool omits setup guidance). Returns a result instead of 500.
          cloudLog({
            severity: "ERROR",
            component: "Fiscal",
            action: "FISCAL_PROFILE_LOAD_ERROR",
            a2a_transfer: false,
            message: "Failed to load business fiscal profile — proceeding with null profile",
            data: {
              businessId,
              errorName: profileError instanceof Error ? profileError.name : "NonError",
              errorMessage: profileError instanceof Error ? profileError.message : String(profileError),
            },
          });
        }
      }

      // FIX 2: capture emit_invoice tool result structured data from the drain
      // loop — mirrors getFunctionResponses pattern in handle-payments-rpc.ts.
      // This gives callers a Gemini-rephrasing-proof path to the CAE + sandbox flag.
      let capturedEmitInvoiceResult: Record<string, unknown> | null = null;

      const agent = createFiscalAgent({ businessId }, fiscalProfile, toolCtx);
      // Finding #8: appName derived from agent.name for consistent ADK session namespace.
      const appName = agent.name;

      const { replyText, error } = await runRpcAgent({
        agent,
        appName,
        userId: "fiscal-rpc-call",
        message: text,
        timeoutMs: FISCAL_ADK_TIMEOUT_MS,
        // FIX 2: cap LLM invocations per turn — mirrors handle-payments-rpc.ts.
        // 10 covers: thinking pass + tool call + tool result + final text = 4 minimum,
        // with headroom for tool error retry. Without this cap, ADK default is 500
        // which allows infinite retry loops on safety-filter or malformed tool calls.
        // The 30s FISCAL_ADK_TIMEOUT_MS is the real hard backstop.
        // Reference: https://google.github.io/adk-docs/runtime/runconfig/
        maxLlmCalls: 10,
        // FIX 2: capture emit_invoice function response before the final-response
        // check — ADK emits function-response events before the final text event.
        onFunctionResponse: ({ name, response }) => {
          if (name === "emit_invoice" && response && capturedEmitInvoiceResult === null) {
            capturedEmitInvoiceResult = response;
          }
        },
      });

      if (error !== null) {
        // Classify and log — shared helper emits FISCAL_AGENT_TIMEOUT /
        // FISCAL_AGENT_MAX_LLM_CALLS / FISCAL_AGENT_RUNNER_ERROR action codes.
        const classified = handleRpcRunnerError(error, "Fiscal", body, contextId, businessId, FISCAL_ADK_TIMEOUT_MS);
        if (classified.earlyResponse !== null) return classified.earlyResponse;
        const parts: A2APart[] = [{ kind: "text", text: classified.replyText }];
        return rpcResult(body.id, { kind: "message", messageId: randomUUID(), role: "agent", parts, contextId });
      }

      // Log silent drains for alerting — FISCAL_AGENT_EMPTY_DRAIN action code.
      if (!replyText && capturedEmitInvoiceResult === null) {
        logRpcAgentEmptyDrain("Fiscal", businessId, contextId);
      }

      // FIX 1: SANDBOX prefix REMOVED from replyText.
      //
      // Prior code prepended "⚠️ Comprobante de SANDBOX..." to replyText when
      // toolCtx.sandboxUsed=true. Downstream, containsOwnerContent() in
      // fiscal-receipt-guards.ts matched "SANDBOX" and silently routed 100% of
      // fiscal receipts (ARCA_REAL_MODE=false is the default) to the generic
      // customer fallback — customer never got the itemized PDF.
      //
      // Canonical 2026 fix: surface sandbox status via structured dataPart on the
      // A2A response so callers (trigger-fiscal-receipt.ts) can act on it
      // programmatically without substring scanning.
      //
      // Pattern: Google ADK A2A structured data exchange — JSON-RPC parts array
      // carries kind:"data" alongside kind:"text" for machine-readable metadata.
      // Reference: https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/
      //
      // Stripe analogy: sandbox/test markers belong in metadata, not in the
      // customer-facing receipt body. Stripe sandboxes suppress customer emails
      // entirely; they do NOT inject "TEST MODE" into the receipt text.
      // Reference: https://docs.stripe.com/sandboxes (sandbox settings docs 2026)
      const parts: A2APart[] = [
        { kind: "text", text: replyText || "Sin respuesta del modelo." },
        // FIX 1: emit sandboxUsed as a structured dataPart so trigger-fiscal-receipt.ts
        // can read reply.dataParts and gate owner-only routing without substring scan.
        ...(toolCtx.sandboxUsed
          ? [{ kind: "data" as const, data: { sandboxUsed: true, sandboxLabel: "SANDBOX" } }]
          : []),
        // FIX 2: forward captured emit_invoice tool result as structured data —
        // avoids relying on prose parsing when Gemini omits the CAE in its text reply.
        ...(capturedEmitInvoiceResult !== null
          ? [{ kind: "data" as const, data: { emitInvoiceResult: capturedEmitInvoiceResult } }]
          : []),
      ];

      return rpcResult(body.id, {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts,
        contextId,
      });
    }

    case "tasks/get":
    case "tasks/cancel":
      return rpcError(body.id, RPC_ERRORS.TASK_NOT_FOUND);

    default:
      return rpcError(body.id, RPC_ERRORS.METHOD_NOT_FOUND);
  }
}
