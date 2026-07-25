// src/lib/mcp/_lib/fiscal-backend.port.ts — Backend-agnostic port for fiscal MCP tools.
//
// Decouples the three fiscal tools from Velora's concrete ARCA emission layer.
// A future adapter (e.g. a different facturación provider) implements this interface
// and requires ZERO changes to fiscal-tools.ts or the MCP server.
//
// Design mirrors catalog-backend.port.ts / engine-adapter.ts:
//   port (this file) → adapter (velora-fiscal.adapter.ts) → factory (fiscal-backend.factory.ts)
//
// tenantId is opaque here — the Velora adapter maps it to businessId internally
// so the port name doesn't hard-wire Velora's domain vocabulary.
//
// Input/output types are inlined from the handler signatures in fiscal-tools.ts.
// They are intentionally narrow (tool-contract shapes) — not the full domain types.
// The port is a seam, not a full domain model.

import type { FiscalReadinessResult } from "@/app/api/agents/fiscal/jsonrpc/_lib/fiscal-readiness";
import type { EmitInvoiceToolResult } from "@/app/api/agents/fiscal/jsonrpc/_lib/emit-invoice-tool";
import type { TipoComprobante } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/types";

// ── get_fiscal_readiness ──────────────────────────────────────────────────────

export interface GetFiscalReadinessInput {
  tenantId: string;
}

export type GetFiscalReadinessOutput = FiscalReadinessResult;

// ── emit_invoice ──────────────────────────────────────────────────────────────

export interface EmitInvoiceInput {
  tenantId: string;
  customerCuit: string;
  amountARS: number;
  tipo: "A" | "B" | "C";
  concept: string;
  /** Optional caller-supplied nonce folded into the idempotency key (mirrors
   *  register_sale's requestId) — without it, two economically-identical but
   *  genuinely distinct invoices within the 30-day retention window would
   *  silently collapse into one AFIP emission. */
  requestId?: string;
}

export type EmitInvoiceOutput = EmitInvoiceToolResult;

// ── emit_nota ─────────────────────────────────────────────────────────────────

export interface CbteAsocInput {
  tipo: TipoComprobante;
  ptoVta: number;
  nro: number;
}

export interface EmitNotaInput {
  tenantId: string;
  customerCuit: string;
  amountARS: number;
  tipo: "A" | "B" | "C";
  kind: "credito" | "debito";
  cbteAsoc: CbteAsocInput;
  concept: string;
  /** Optional caller-supplied nonce folded into the idempotency key — same
   *  rationale as EmitInvoiceInput.requestId. */
  requestId?: string;
}

export type EmitNotaOutput = EmitInvoiceToolResult;

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * Backend-agnostic fiscal port for the MCP fiscal tool pack.
 *
 * Every method maps to one MCP tool (get_fiscal_readiness, emit_invoice, emit_nota).
 * Throw an Error with a domain code (e.g. "EMIT_FAILED") for error-path handling —
 * fiscal-tools.ts converts thrown errors to MCP isError responses.
 *
 * Tenant isolation is enforced by each adapter via the opaque tenantId field.
 *
 * CRITICAL: Do NOT add retry or idempotency at this level — AFIP FECAESolicitar
 * is non-idempotent. Retry semantics live inside emit-invoice.ts (one auth retry only).
 */
export interface FiscalBackend {
  getFiscalReadiness(input: GetFiscalReadinessInput): Promise<GetFiscalReadinessOutput>;
  emitInvoice(input: EmitInvoiceInput): Promise<EmitInvoiceOutput>;
  emitNota(input: EmitNotaInput): Promise<EmitNotaOutput>;
}
