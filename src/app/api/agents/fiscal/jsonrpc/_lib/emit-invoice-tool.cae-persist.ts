// CAE persistence helper for emit-invoice-tool. Extracted to keep parent ≤ 300 LOC.
// Writes CAE fields back to the Invoice row after a successful real WSFE call.
// Sandbox results are intentionally excluded — they carry no legal CAE.
// AFIP RG 4291/2018: builds the fiscal QR URL when fields are available.
//
// Phase 2 S5: DB write delegated to core via HTTP (writebackCae) instead of
// calling prismaInvoiceRepository.persistCaeFields directly. The fail-soft
// contract is preserved here: WSFE already emitted the CAE at ARCA — if the
// HTTP writeback fails, log ERROR (compliance gap) but do NOT throw, so the
// invoice emission is not unwound. The HTTP client (cae-writeback.ts) always
// throws on failure; this caller catches and absorbs.

import { cloudLog } from "@/lib/cloud-logger";
import { writebackCae } from "./cae-writeback";
import { buildAfipQrUrl } from "./arca-real/afip-qr";
import type { EmitResult } from "./arca-real/emit-invoice";

export interface PersistCaeInput {
  businessId: string;
  invoiceId: string;
  businessCuit: string | null;
  invoiceDate: string | null;
  customerCuit: string;
  amountARS: number;
  raw: EmitResult;
  resultCae: string;
  resultNumero: number;
  resultTipo: string;
  resultVencimiento: string;
}

function parseCaeFchVto(s: string): Date | null {
  if (s && /^\d{8}$/.test(s)) {
    return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  }
  return null;
}

function resolveInvoiceDate(invoiceId: string, injected: string | null): string {
  if (injected) return injected;
  cloudLog({
    severity: "WARNING",
    component: "Fiscal",
    action: "INVOICE_DATE_FALLBACK_TODAY",
    a2a_transfer: false,
    message:
      "toolCtx.invoiceDate not injected — falling back to today (ART). " +
      "Backdated sales will produce an incorrect QR date. Check caller.",
    data: { invoiceId },
  });
  return new Date()
    .toLocaleDateString("es-AR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "America/Argentina/Buenos_Aires",
    })
    .split("/")
    .reverse()
    .join("-");
}

export async function persistCaeAndQr(input: PersistCaeInput): Promise<void> {
  const { businessId, invoiceId, businessCuit, invoiceDate, customerCuit, amountARS, raw } = input;

  // Fail LOUD, not silent (JD finding — money/fiscal path). WSFE already emitted
  // the CAE. If businessId is missing we must NOT call the port with "" — it would
  // match 0 rows and silently drop the CAE while AFIP considers it emitted. Log
  // ERROR and skip so ops can diagnose the legal-compliance gap.
  if (!businessId) {
    cloudLog({
      severity: "ERROR",
      component: "Fiscal",
      action: "INVOICE_CAE_PERSIST_NO_BUSINESS_ID",
      a2a_transfer: false,
      message: "businessId missing — CAE NOT persisted though WSFE emitted it",
      data: { invoiceId, cae: input.resultCae },
    });
    return;
  }

  const caeFchVtoDate = parseCaeFchVto(input.resultVencimiento);

  let fiscalQrUrl: string | null = null;
  const nonSandboxRaw = typeof raw === "object" && !raw.sandbox ? raw : null;

  if (businessCuit && nonSandboxRaw) {
    const invoiceDateStr = resolveInvoiceDate(invoiceId, invoiceDate);
    const nroDocRec = customerCuit && /^\d{11}$/.test(customerCuit) ? Number(customerCuit) : 0;
    const tipoDocRec = nroDocRec > 0 ? 80 : 99;
    fiscalQrUrl = buildAfipQrUrl({
      cuit: businessCuit,
      ptoVta: nonSandboxRaw.puntoVenta,
      tipoCmp: nonSandboxRaw.tipoComprobante,
      nroComp: nonSandboxRaw.numero,
      fecha: invoiceDateStr,
      importe: amountARS,
      moneda: "PES",
      ctz: 1,
      tipoDocRec,
      nroDocRec,
      tipoCodAut: "E",
      codAut: nonSandboxRaw.cae,
    });
  }

  try {
    // Phase 2 S5: delegate to core via HTTP instead of direct Prisma write.
    // writebackCae always throws on failure (hard stop from the client's perspective).
    // This caller absorbs the error to preserve the fail-soft contract: WSFE already
    // emitted the CAE at ARCA — do NOT throw and unwind the legal emission.
    await writebackCae({
      businessId,
      invoiceId,
      caeCode: input.resultCae,
      caeFchVto: caeFchVtoDate,
      fiscalTipo: nonSandboxRaw?.tipoComprobante ?? null,
      fiscalPtoVta: nonSandboxRaw?.puntoVenta ?? null,
      fiscalNumero: input.resultNumero,
      fiscalEmittedAt: new Date(),
      fiscalQrUrl,
    });
    cloudLog({
      severity: "INFO",
      component: "Fiscal",
      action: "INVOICE_CAE_PERSISTED",
      a2a_transfer: false,
      message: "CAE fields written to Invoice row via core HTTP endpoint after WSFE success",
      data: { invoiceId, cae: input.resultCae, fiscalNumero: input.resultNumero, tipo: input.resultTipo },
    });
  } catch (writebackErr) {
    // Fail-soft: WSFE succeeded — never throw and unwind the legal emission.
    // writebackCae already logged the specific ERROR (no-secret, network, HTTP error).
    cloudLog({
      severity: "ERROR",
      component: "Fiscal",
      action: "INVOICE_CAE_WRITEBACK_ABSORBED",
      a2a_transfer: false,
      message: "CAE writeback failed — WSFE succeeded but CAE NOT stored (compliance gap)",
      data: {
        invoiceId,
        cae: input.resultCae,
        errorMessage: writebackErr instanceof Error ? writebackErr.message : String(writebackErr),
      },
    });
  }
}
