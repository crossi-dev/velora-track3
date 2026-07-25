// velora-fiscal.adapter.idempotency.ts — Idempotency machinery for VeloraFiscalAdapter.
//
// Extracted from velora-fiscal.adapter.ts to respect the 300-line file-size contract.
// This module owns:
//   - puntoVenta resolution (C-1 fix)
//   - Idempotency key derivation (pure)
//   - Transport vs AFIP-level error classification (H-1)
//   - withEmitIdempotency / executeAndComplete orchestration (H-2, H-3)
//
// Design notes:
//   - All exports are implementation details of VeloraFiscalAdapter; do not
//     import from outside this adapter pair.
//   - See velora-fiscal.adapter.ts for the full rationale and constraint comments.
//
// M-1 NOTE — pending-prune cadence:
//   The code refers to a "TTL backstop" for stuck pending idempotency records.
//   The actual prune frequency is determined by velora-audit-cleanup, which runs
//   DAILY at 04:00 UTC ("0 4 * * *" — see scripts/scheduler-jobs.json).
//   This means a stuck pending row (failed complete() or unresolved transport error)
//   blocks retries for up to ~24 h, NOT 5 min.
//   The 5-min constant in idempotency.ts is the row age threshold for pruning,
//   not the pruning interval.
//   RECOMMENDATION: add a dedicated frequent cron (e.g. every 5–15 min) that
//   calls pruneIdempotencyRecords for fiscal.emit_* rows, or promote the pending-prune
//   step of velora-audit-cleanup to run on a tighter schedule.
//   (tracked internally)

import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { cloudLog } from "@/lib/cloud-logger";
import type { EmitInvoiceToolResult } from "@/app/api/agents/fiscal/jsonrpc/_lib/emit-invoice-tool";
import type { CbteAsocInput } from "./fiscal-backend.port";

// ── Action type constants ─────────────────────────────────────────────────────

export const ACTION_EMIT_INVOICE = "fiscal.emit_invoice" as const;
export const ACTION_EMIT_NOTA = "fiscal.emit_nota" as const;
type EmitActionType = typeof ACTION_EMIT_INVOICE | typeof ACTION_EMIT_NOTA;

// ── Sandbox / no-credential puntoVenta default ────────────────────────────────
//
// C-1 FIX: puntoVenta must be included in the idempotency key so that two
// emissions for the SAME business but DIFFERENT puntos de venta produce distinct
// keys and are NOT deduplicated against each other.
//
// The value used in the key MUST match the value emit() will actually use.
// emit-invoice.ts resolves puntoVenta from ArcaCredential.puntoVenta when
// ARCA_REAL_MODE=true and a credential row exists; otherwise sandbox (no AFIP number).
//
// We mirror that logic: load ArcaCredential.puntoVenta (same DB row that emit()
// loads internally), or fall back to sentinel "0" for sandbox paths.
// AFIP puntoVenta starts at 1, so "0" is collision-free.

const SANDBOX_PTO_VTA_SENTINEL = "0";

export async function resolvePuntoVenta(businessId: string): Promise<string> {
  const cred = await prisma.arcaCredential.findUnique({
    where: { businessId },
    select: { puntoVenta: true },
  });
  if (cred?.puntoVenta != null) {
    return String(cred.puntoVenta);
  }
  return SANDBOX_PTO_VTA_SENTINEL;
}

// ── H-1: transport vs AFIP-level error classification ────────────────────────
//
// Transport/timeout errors → do NOT release the record (number may be consumed).
// AFIP-level rejections    → safe to release (number NOT consumed, AFIP rejected).

export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  if ("code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED") return true;
  }
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|network timeout|socket hang up/i.test(err.message)) {
    return true;
  }
  return false;
}

// ── Key derivation (pure, stable) ─────────────────────────────────────────────
//
// Only financially-material fields are hashed — concept EXCLUDED (free-text varies
// across LLM retries without changing economic identity).
// puntoVenta INCLUDED (C-1 fix): different AFIP series MUST NOT share a key.
// amountARS.toFixed(2) canonicalises floating-point representation.
//
// requestId (optional) is folded in last, mirroring register_sale's buildSaleIdemKey:
// without it, two GENUINELY DISTINCT invoices sharing the same economic parameters
// (same customer, amount, tipo, punto de venta — e.g. two identical walk-in sales,
// or the same recurring monthly retainer) would derive the SAME key and the second
// call would silently return the first invoice's CAE as a "replay" — no second AFIP
// emission, no error, just a stale CAE. A genuine retry omits requestId (or reuses
// the same one) so it still dedupes correctly; a new economic invoice gets a fresh one.

export function deriveEmitInvoiceKey(
  tenantId: string,
  tipo: string,
  customerCuit: string,
  amountARS: number,
  puntoVenta: string,
  requestId?: string,
): string {
  const hash = createHash("sha256")
    .update([tenantId, tipo, customerCuit, amountARS.toFixed(2), puntoVenta, requestId ?? ""].join("|"))
    .digest("hex");
  return `fiscal.emit_invoice:${hash}`;
}

export function deriveEmitNotaKey(
  tenantId: string,
  tipo: string,
  kind: string,
  customerCuit: string,
  amountARS: number,
  cbteAsoc: CbteAsocInput,
  puntoVenta: string,
  requestId?: string,
): string {
  const hash = createHash("sha256")
    .update(
      [
        tenantId,
        tipo,
        kind,
        customerCuit,
        amountARS.toFixed(2),
        String(cbteAsoc.tipo),
        String(cbteAsoc.ptoVta),
        String(cbteAsoc.nro),
        puntoVenta,
        requestId ?? "",
      ].join("|"),
    )
    .digest("hex");
  return `fiscal.emit_nota:${hash}`;
}

// ── executeAndComplete ─────────────────────────────────────────────────────────
//
// Runs executeFn(), handles H-1 error classification on failure, and calls
// complete() on success. Extracted so withEmitIdempotency stays ≤ 30 LOC.

export async function executeAndComplete(
  tenantId: string,
  actionType: EmitActionType,
  idempotencyKey: string,
  recordId: string,
  executeFn: () => Promise<EmitInvoiceToolResult>,
): Promise<EmitInvoiceToolResult> {
  let result: EmitInvoiceToolResult;

  try {
    result = await executeFn();
  } catch (emitErr) {
    if (isTransportError(emitErr)) {
      // H-1: do NOT release — AFIP may have consumed a sequential number.
      // Pending row blocked until daily audit-cleanup prune (see M-1 note above).
      // Manual FECompConsultar check required before retrying.
      cloudLog({
        severity: "WARNING",
        component: "Fiscal",
        action: "EMIT_TRANSPORT_ERROR_NO_RELEASE",
        a2a_transfer: false,
        message:
          "[FISCAL] Transport/timeout error during AFIP emission — idempotency record left pending. " +
          "AFIP may have consumed a sequential number. Manual FECompConsultar check required before retry. " +
          "Pending row pruned by daily audit-cleanup cron (see M-1 note).",
        data: {
          businessId: tenantId,
          actionType,
          idempotencyKey,
          recordId,
          error: emitErr instanceof Error ? emitErr.message : String(emitErr),
        },
      });
      throw Object.assign(
        new Error(
          `EMIT_TRANSPORT_ERROR: network/timeout error during AFIP emission. ` +
            `The AFIP sequential number may have been consumed. ` +
            `Manual investigation via FECompConsultar required before retrying. ` +
            `Original: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
        ),
        { retryable: false },
      );
    }
    // AFIP-level rejection — no number consumed, safe to release.
    await prismaIdempotencyAdapter.release(recordId);
    throw emitErr;
  }

  // emit() SUCCEEDED — AFIP sequential number is now consumed.
  // Do NOT release if complete() throws: that would allow a retry burning another number.
  try {
    await prismaIdempotencyAdapter.complete(null, recordId, 200, result);
  } catch (completeErr) {
    cloudLog({
      severity: "CRITICAL",
      component: "Fiscal",
      action: "EMIT_IDEMPOTENCY_COMPLETE_FAILED",
      a2a_transfer: false,
      message:
        "[FATAL] AFIP invoice emitted but idempotency record could not be completed. " +
        "Do NOT release the record — a retry would burn another AFIP sequential number. " +
        "Manual investigation required.",
      data: {
        businessId: tenantId,
        actionType,
        idempotencyKey,
        recordId,
        cae: result.cae,
        numero: result.numero,
        error: completeErr instanceof Error ? completeErr.message : String(completeErr),
      },
    });
    throw completeErr;
  }

  return result;
}

// ── withEmitIdempotency ────────────────────────────────────────────────────────
//
// Shared begin/execute/complete/release control flow for both emitInvoice and
// emitNota. Handles H-2 (replayed marker) and H-3 (conflict/missing outcomes).

export async function withEmitIdempotency(
  tenantId: string,
  actionType: EmitActionType,
  idempotencyKey: string,
  requestBody: unknown,
  executeFn: () => Promise<EmitInvoiceToolResult>,
): Promise<EmitInvoiceToolResult & { replayed?: true }> {
  const outcome = await prismaIdempotencyAdapter.begin({
    businessId: tenantId,
    actionType,
    idempotencyKey,
    requestBody,
  });

  if (outcome.kind === "replay") {
    // H-2: add replayed:true so the caller knows concept and other fields
    // are from the ORIGINAL emission, not the current call parameters.
    const stored = outcome.body as EmitInvoiceToolResult;
    return { ...stored, replayed: true as const };
  }

  if (outcome.kind === "in_flight") {
    throw new Error("EMIT_IN_FLIGHT: concurrent emission in progress, retry in a few seconds");
  }

  if (outcome.kind === "conflict") {
    // H-3: prune-race — row vanished between P2002 collision and readback.
    // Retry begin() once; on success proceed normally; otherwise descriptive error.
    const retry = await prismaIdempotencyAdapter.begin({
      businessId: tenantId,
      actionType,
      idempotencyKey,
      requestBody,
    });
    if (retry.kind === "execute") {
      return executeAndComplete(tenantId, actionType, idempotencyKey, retry.recordId, executeFn);
    }
    if (retry.kind === "replay") {
      const stored = retry.body as EmitInvoiceToolResult;
      return { ...stored, replayed: true as const };
    }
    throw new Error(
      `EMIT_IDEMPOTENCY_CONFLICT: idempotency key "${idempotencyKey}" was used for a different ` +
        `request (hash mismatch). Use a new key for a new emission.`,
    );
  }

  if (outcome.kind === "missing") {
    // H-3: empty key — the adapter always derives a non-empty key, so this is a bug.
    throw new Error(
      "EMIT_IDEMPOTENCY_MISSING: empty idempotency key derived — this is a bug in the adapter.",
    );
  }

  // outcome.kind === "execute"
  return executeAndComplete(tenantId, actionType, idempotencyKey, outcome.recordId, executeFn);
}
