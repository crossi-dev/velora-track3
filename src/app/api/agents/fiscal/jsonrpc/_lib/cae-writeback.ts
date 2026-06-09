// Fiscal CAE writeback — HTTP call to the core internal endpoint.
//
// Phase 2 S5: replaces the direct prismaInvoiceRepository.persistCaeFields call
// in emit-invoice-tool.cae-persist.ts with a PATCH /api/internal/agents/invoice-cae
// call to core. Auth: CRON_SECRET bearer (same pattern as shipment-writeback.ts).
//
// Error contract (HARD STOP — fiscal-critical): on any failure (network, timeout,
// non-200) throws FiscalCaeWritebackError. The caller MUST NOT treat a write
// failure as success — WSFE emitted the CAE at ARCA but if it is not stored in
// Velora, the invoice is legally emitted without a persisted CAE (compliance gap).
// Mirrors the ShipmentWritebackError hard-stop pattern from Phase 2 S4.
//
// Direction: VELORA_APP_URL (not AGENTS_BASE_URL) — this is agent → core.
//
// Fail-soft behavior lives in the CALLER (cae-persist.ts): the caller wraps this
// in a try/catch and chooses not to throw (WSFE already succeeded at ARCA; the
// only option at that point is loud logging + continue). This client always throws
// on failure — the fail-soft decision belongs to the caller, not here.

import { getCoreBaseUrl } from "@/lib/core-base-url";
import { cloudLog } from "@/lib/cloud-logger";
import type { InvoiceCaePersistArgs } from "@/domain/ports/invoice.repository.port";

/** Thrown when the CAE writeback HTTP call fails for any reason. */
export class FiscalCaeWritebackError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FiscalCaeWritebackError";
  }
}

// 10s default (env-overridable). The Fiscal agent ADK timeout is the real
// backstop, but this is a WRITE over cold Supabase pgbouncer (2-4s under load) —
// too tight a timeout would abort a write that was going to succeed, leaving the
// CAE at ARCA but NOT in Velora (legal compliance gap). Mirror S4 comment.
const CAE_WRITEBACK_TIMEOUT_MS =
  Number(process.env.CAE_WRITEBACK_TIMEOUT_MS) || 10_000;

export async function writebackCae(args: InvoiceCaePersistArgs): Promise<void> {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) {
    cloudLog({
      severity: "ERROR",
      component: "Fiscal",
      action: "INVOICE_CAE_WRITEBACK_NO_SECRET",
      a2a_transfer: false,
      message: "writebackCae: CRON_SECRET is not set — cannot authenticate to core",
      data: { businessId: args.businessId, invoiceId: args.invoiceId },
    });
    throw new FiscalCaeWritebackError("CRON_SECRET not configured");
  }

  const url = `${getCoreBaseUrl()}/api/internal/agents/invoice-cae`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAE_WRITEBACK_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        businessId: args.businessId,
        invoiceId: args.invoiceId,
        caeCode: args.caeCode,
        caeFchVto: args.caeFchVto ? args.caeFchVto.toISOString() : null,
        fiscalTipo: args.fiscalTipo,
        fiscalPtoVta: args.fiscalPtoVta,
        fiscalNumero: args.fiscalNumero,
        fiscalEmittedAt: args.fiscalEmittedAt.toISOString(),
        fiscalQrUrl: args.fiscalQrUrl,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "Fiscal",
      action: "INVOICE_CAE_WRITEBACK_FETCH_ERROR",
      a2a_transfer: false,
      message: "writebackCae: HTTP call to core failed",
      data: {
        businessId: args.businessId,
        invoiceId: args.invoiceId,
        errorName: err instanceof Error ? err.name : "NonError",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw new FiscalCaeWritebackError(err instanceof Error ? err.message : "fetch_failed");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    cloudLog({
      severity: "ERROR",
      component: "Fiscal",
      action: "INVOICE_CAE_WRITEBACK_HTTP_ERROR",
      a2a_transfer: false,
      message: `writebackCae: core returned ${res.status}`,
      data: {
        businessId: args.businessId,
        invoiceId: args.invoiceId,
        status: res.status,
      },
    });
    throw new FiscalCaeWritebackError(`non-200 from core: ${res.status}`, res.status);
  }
}
