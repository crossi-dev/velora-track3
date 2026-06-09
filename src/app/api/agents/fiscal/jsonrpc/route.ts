// A2A v0.3.0 JSON-RPC endpoint for the Velora Fiscal Agent.
// Auth: per-tenant derived X-API-Key (required) + X-Agent-Assertion JWT (Ed25519).
// Rebuilt on agent-rpc-factory.ts (2026-05-25) — removes ~55 lines of duplicated
// auth/rate-limit/error scaffold shared with Equipo, Payments, Ventas, Logística.
//
// Fiscal-specific: invoiceId is extracted from the A2A text payload inside the
// handle callback (not in the factory) so the CAE persistence path (commit 3663ae14)
// and idempotency guard remain intact. businessId is provided by the factory.

// 45s gives comfortable margin above FISCAL_ADK_TIMEOUT_MS (30s) — accommodates
// WSAA+WSFE dual SOAP round-trips (~10s each) + Gemini latency + cleanup headroom.
export const maxDuration = 45;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import {
  handleFiscalRpc,
  extractTextFromParams,
  extractInvoiceIdFromText,
} from "./_lib/handle-fiscal-rpc";

export const POST = createAgentRpcRoute({
  agentName: "fiscal",
  callerIdentity: "supervisor",
  rateLimit: { bucket: "fiscal-a2a", max: 20, windowSec: 60 },
  handle: (body, ctx) => {
    // invoiceId extraction is fiscal-specific: threads through to EmitInvoiceToolContext
    // so the CAE returned by WSFE is persisted to the Invoice row (idempotency guard —
    // prevents duplicate AFIP-registered comprobante on Supervisor retry per RG 2485).
    const rawText = extractTextFromParams(body.params);
    const rawInvoiceId = rawText ? extractInvoiceIdFromText(rawText) : null;
    const invoiceId =
      rawInvoiceId && /^[a-z0-9]{20,30}$/.test(rawInvoiceId) ? rawInvoiceId : null;
    return handleFiscalRpc(body, { businessId: ctx.businessId, invoiceId });
  },
});
