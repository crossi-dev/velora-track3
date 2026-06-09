// src/lib/mcp/_lib/velora-fiscal.adapter.ts — Velora concrete implementation of FiscalBackend.
//
// Delegates to the EXISTING fiscal pipeline functions:
//   - getFiscalReadiness()    from fiscal-readiness.ts
//   - emit()                  from arca-real/emit-invoice.ts
//   - normaliseEmitResult()   from emit-invoice-tool.ts
//   - prisma.business.findUnique (ivaCondition lookup)
//
// Pure restructure — zero behavioral change for first-call (non-retry) paths.
// The prisma.business.findUnique + emit + normaliseEmitResult sequence is preserved
// EXACTLY as it appears in fiscal-tools.ts.
//
// Design source: velora-catalog.adapter.ts (composition over inheritance).
// The adapter is a thin delegation layer: it doesn't add logic, it translates shapes.
//
// HARD CONSTRAINTS (money path — do NOT relax):
//   - ArcaCredential model is UNTOUCHED (loaded inside emit() as before).
//   - WSAA ticket cache (in-memory L1 + DB L2) is UNTOUCHED (inside wsaa.ts).
//   - wsaa.ts / wsfe.ts / emit-invoice.ts internals are UNTOUCHED.
//   - ARCA_REAL_MODE / ARCA_PRODUCTION routing is UNTOUCHED (inside emit()).
//
// IDEMPOTENCY LAYER (added — compliance path):
//   Wraps emitInvoice and emitNota with Velora's existing idempotency infra
//   (prismaIdempotencyAdapter → beginIdempotentMutation / complete / release).
//   Key is SHA-256 of financially-material inputs only — concept EXCLUDED (see design),
//   puntoVenta INCLUDED (C-1 fix — different AFIP series MUST NOT share a key).
//   Control flow:
//     execute   → run emission exactly as before, then complete the record.
//     replay    → return stored result with replayed:true marker (H-2).
//     in_flight → throw EMIT_IN_FLIGHT.
//   On error during execute — H-1: distinguish transport vs AFIP-level errors:
//     AFIP-level rejection (no number consumed) → release() as before.
//     Transport/timeout error (number may be consumed) → do NOT release; leave
//       record pending; daily pending-prune (see M-1 in adapter.idempotency.ts) is backstop.
//   CRITICAL: if emit() SUCCEEDS but complete() throws → do NOT release.
//   Releasing would allow a duplicate AFIP sequential number. Log FATAL instead.
//
// Idempotency details (key derivation, transport classification, control flow)
// live in velora-fiscal.adapter.idempotency.ts to keep this file ≤ 300 lines.
//
// actionTypes registered: "fiscal.emit_invoice" | "fiscal.emit_nota"

import type {
  FiscalBackend,
  GetFiscalReadinessInput,
  GetFiscalReadinessOutput,
  EmitInvoiceInput,
  EmitInvoiceOutput,
  EmitNotaInput,
  EmitNotaOutput,
} from "./fiscal-backend.port";
import { prisma } from "@/lib/prisma";
import { getFiscalReadiness } from "@/app/api/agents/fiscal/jsonrpc/_lib/fiscal-readiness";
import { emit, resolveInvoiceType } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice";
import { normaliseEmitResult } from "@/app/api/agents/fiscal/jsonrpc/_lib/emit-invoice-tool";
import {
  ACTION_EMIT_INVOICE,
  ACTION_EMIT_NOTA,
  resolvePuntoVenta,
  deriveEmitInvoiceKey,
  deriveEmitNotaKey,
  withEmitIdempotency,
} from "./velora-fiscal.adapter.idempotency";

// ── Adapter ───────────────────────────────────────────────────────────────────

export class VeloraFiscalAdapter implements FiscalBackend {
  async getFiscalReadiness(input: GetFiscalReadinessInput): Promise<GetFiscalReadinessOutput> {
    const { tenantId: businessId } = input;
    return getFiscalReadiness(businessId);
  }

  async emitInvoice(input: EmitInvoiceInput): Promise<EmitInvoiceOutput> {
    const { tenantId: businessId, amountARS, tipo, concept } = input;
    // #1 FIX: strip non-digits from customerCuit so AFIP never sees "20-12345678-9".
    // The description claims "hyphens and spaces stripped" — this makes it true.
    const customerCuit = input.customerCuit?.replace(/\D/g, "") ?? input.customerCuit;

    // MEDIUM-3 FIX: resolve condicionIva and canonicalize tipo BEFORE deriving the
    // idempotency key. Without this, an agent supplying tipo="B" for a Monotributista
    // and a retry supplying the already-corrected tipo="C" produce DIFFERENT keys →
    // a second AFIP emission → a burned invoice number for the same economic invoice.
    // resolveInvoiceType() is the same function emit() uses internally (mapTipo calls
    // it via condicionIva="MT" check) so the canonical tipo is consistent.
    //
    // C-1 FIX: also resolve puntoVenta before key derivation so different AFIP series
    // (multiple puntos de venta) never share a key.
    const businessRow = await prisma.business.findUnique({
      where: { id: businessId },
      select: { ivaCondition: true },
    });
    const condicionIva = businessRow?.ivaCondition ?? null;
    const canonicalTipo = resolveInvoiceType(tipo, condicionIva);
    const puntoVenta = await resolvePuntoVenta(businessId);
    const idempotencyKey = deriveEmitInvoiceKey(businessId, canonicalTipo, customerCuit, amountARS, puntoVenta);

    return withEmitIdempotency(
      businessId,
      ACTION_EMIT_INVOICE,
      idempotencyKey,
      { tenantId: businessId, tipo: canonicalTipo, customerCuit, amountARS },
      async () => {
        const raw = await emit({
          businessId,
          customerCuit,
          amountARS,
          // Pass the canonical tipo (same value used in the idempotency key) so the
          // key and the emission can never diverge. resolveInvoiceType is idempotent.
          tipo: canonicalTipo,
          concept,
          condicionIva,
        });

        // #2 FIX: when ARCA_REAL_MODE=true but no ArcaCredential exists, emit() returns
        // a sandbox result with misconfigured=true. The idempotency wrapper would store
        // this as a success and the caller would believe a legal invoice was emitted.
        // Throw here so isError propagates correctly — no real AFIP number was consumed.
        if ("misconfigured" in raw && raw.misconfigured === true) {
          throw new Error(
            "FISCAL_MISCONFIGURED: ARCA_REAL_MODE is on but no credential is configured " +
              "for this business — invoice was NOT legally emitted. " +
              "Configure an ArcaCredential row or disable ARCA_REAL_MODE.",
          );
        }

        const normalised = normaliseEmitResult(raw, customerCuit, amountARS, concept);
        // Attach _raw so the BACKEND path in emit-invoice-tool.ts can call
        // persistCaeAndQr with the raw WSFE fields (tipoComprobante, puntoVenta)
        // needed to build the AFIP RG 4291 QR URL. Only populated for real (non-sandbox)
        // results — sandbox raw carries none of these fields.
        if (!raw.sandbox) {
          normalised._raw = {
            tipoComprobante: raw.tipoComprobante,
            puntoVenta: raw.puntoVenta,
          };
        }
        return normalised;
      },
    );
  }

  async emitNota(input: EmitNotaInput): Promise<EmitNotaOutput> {
    const { tenantId: businessId, amountARS, tipo, kind, cbteAsoc, concept } = input;
    // #1 FIX: strip non-digits from customerCuit (same as emitInvoice).
    const customerCuit = input.customerCuit?.replace(/\D/g, "") ?? input.customerCuit;

    // MEDIUM-3 FIX (mirrors emitInvoice): resolve condicionIva and canonicalize tipo
    // BEFORE deriving the idempotency key. Without this, a Monotributista retry that
    // supplies tipo="A" then the corrected tipo="C" derives DIFFERENT keys → a second
    // AFIP nota for the SAME economic document. resolveInvoiceType is idempotent.
    // C-1 FIX: resolve puntoVenta before key derivation (different AFIP series ≠ same key).
    const businessRow = await prisma.business.findUnique({
      where: { id: businessId },
      select: { ivaCondition: true },
    });
    const condicionIva = businessRow?.ivaCondition ?? null;
    const canonicalTipo = resolveInvoiceType(tipo, condicionIva);
    const puntoVenta = await resolvePuntoVenta(businessId);
    const idempotencyKey = deriveEmitNotaKey(
      businessId,
      canonicalTipo,
      kind,
      customerCuit,
      amountARS,
      cbteAsoc,
      puntoVenta,
    );

    return withEmitIdempotency(
      businessId,
      ACTION_EMIT_NOTA,
      idempotencyKey,
      { tenantId: businessId, tipo: canonicalTipo, kind, customerCuit, amountARS, cbteAsoc },
      async () => {
        const raw = await emit({
          businessId,
          customerCuit,
          amountARS,
          tipo: canonicalTipo,
          concept,
          condicionIva,
          noteKind: kind,
          cbteAsoc,
        });

        // #2 FIX: same misconfigured guard as emitInvoice.
        if ("misconfigured" in raw && raw.misconfigured === true) {
          throw new Error(
            "FISCAL_MISCONFIGURED: ARCA_REAL_MODE is on but no credential is configured " +
              "for this business — nota was NOT legally emitted. " +
              "Configure an ArcaCredential row or disable ARCA_REAL_MODE.",
          );
        }

        const normalised = normaliseEmitResult(raw, customerCuit, amountARS, concept);
        // Mirror emitInvoice: attach _raw for callers that need WSFE fields for QR.
        if (!raw.sandbox) {
          normalised._raw = {
            tipoComprobante: raw.tipoComprobante,
            puntoVenta: raw.puntoVenta,
          };
        }
        return normalised;
      },
    );
  }
}
