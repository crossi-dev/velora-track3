// emit-invoice-tool.types.ts — Shared types and ADK schema for emit_invoice.
//
// Extracted from emit-invoice-tool.ts to keep that file under the 300-line limit.
// All exports here are re-exported from emit-invoice-tool.ts for backward compat.
//
// Schema contract (2026-05-26):
//   Raw `Schema` from `@google/genai` (Type enum) — NOT Zod v3.
//   Zod v3 emits `additionalProperties: false` on nested objects and
//   `exclusiveMinimum: true` (Draft 4 boolean form) which Vertex AI's
//   Schema validator silently rejects → no function declarations → Gemini
//   returns empty candidate → drainEvents yields zero events → fallback fires.
//   Canonical in-repo reference: payments-register-promesa-sale-tool.ts.
//   AFIP invoice types (A/B/C) per AFIP RG 2485 and resolución general 4291.

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import type { FiscalBackend } from "@/lib/mcp/_lib/fiscal-backend.port";

// ── Tool parameter schema ─────────────────────────────────────────────────────

export const emitInvoiceParams: Schema = {
  type: Type.OBJECT,
  properties: {
    customerCuit: {
      type: Type.STRING,
      description: "Validated customer CUIT/CUIL (11 digits, formatted or raw)",
    },
    amountARS: {
      type: Type.NUMBER,
      description: "Invoice total in Argentine pesos",
    },
    tipo: {
      type: Type.STRING,
      enum: ["A", "B", "C"],
      description:
        "Invoice type per AFIP RG 2485: A = IVA discriminado (B2B), B = consumidor final, C = monotributo",
    },
    concept: {
      type: Type.STRING,
      description: "Items or concept description (optional)",
    },
  },
  required: ["customerCuit", "amountARS", "tipo"],
};

// Runtime input type — mirrors the Schema above. Replaces z.infer<typeof emitInvoiceParams>.
export type EmitInvoiceInput = {
  customerCuit: string;
  amountARS: number;
  tipo: "A" | "B" | "C";
  concept?: string;
};

// ── Normalised return type ────────────────────────────────────────────────────

/** Stable shape returned by emit_invoice to the ADK agent — independent of
 *  whether arcaEmit ran in real or sandbox mode. */
export interface EmitInvoiceToolResult {
  sandbox: boolean;
  cae: string;
  /** CAE expiry date — YYYYMMDD. Mapped from vencimiento (sandbox) or vencimientoCae (real). */
  vencimiento: string;
  /**
   * Invoice type letter. "UNKNOWN:<code>" when AFIP returns a tipoComprobante
   * code not in the known map (1=A, 6=B, 11=C) — never silently defaults.
   */
  tipo: "A" | "B" | "C" | string;
  numero: number;
  customerCuit: string;
  amountARS: number;
  concept: string;
  /**
   * Present when getFiscalReadiness reported ready === false (F-2), or when
   * ARCA_REAL_MODE=true but the ArcaCredential is missing (C-2).
   * The agent must relay this to the owner verbatim — never rewrite.
   */
  setupGuidance?: string;
  /** Internal (BACKEND path): raw WSFE fields for QR building. Populated by
   *  VeloraFiscalAdapter; not part of the stable agent contract. */
  _raw?: { tipoComprobante: number; puntoVenta: number };
}

// ── Tool execution context ────────────────────────────────────────────────────

/** Mutable flag set by the tool's execute closure so the RPC handler can append
 *  a deterministic sandbox notice without relying on LLM discretion. */
export interface EmitInvoiceToolContext {
  sandboxUsed: boolean;
  /** Readiness result from getFiscalReadiness — injected by the RPC handler (F-2). */
  readiness?: import("./fiscal-readiness").FiscalReadinessResult;
  /** Business IVA condition — used for sandbox invoice-type correction (F-3). */
  businessCondicionIva?: string | null;
  /**
   * Invoice row ID — injected by sale-post-commit so the tool can write the
   * CAE fields back after a successful real WSFE call (AFIP RG 2485 persistence).
   * When absent the write is skipped (e.g. owner-initiated fiscal calls without a sale).
   */
  invoiceId?: string | null;
  /**
   * Business CUIT (11 digits, no hyphens) — injected from the business row.
   * Required to build the AFIP RG 4291 QR URL alongside the CAE fields.
   * When absent the QR URL is skipped (fiscalQrUrl stays null).
   */
  businessCuit?: string | null;
  /**
   * Invoice date (YYYY-MM-DD) used in the QR JSON payload.
   * When absent, today's date in Buenos Aires time is used as a fallback.
   */
  invoiceDate?: string | null;
  /**
   * Optional FiscalBackend injected for testing — bypasses both the
   * AGENT_FISCAL_BACKEND env flag and the legacy arcaEmit path.
   * Default: null → falls through to flag-based routing.
   */
  backendOverride?: FiscalBackend | null;
}
