import PDFDocument from "pdfkit";
import { drawInvoiceHeader } from "./invoice-pdf-header";
import { drawInvoiceCustomer } from "./invoice-pdf-customer";
import { drawInvoiceItems } from "./invoice-pdf-items";
import { drawInvoiceTotalsAndFooter } from "./invoice-pdf-totals";
import type { InvoiceLayout, InvoicePdfPayload } from "./invoice-pdf-types";

export type { InvoicePdfPayload } from "./invoice-pdf-types";

const STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  issued: "Emitida",
  sent: "Enviada",
  paid: "Pagada",
};

export function buildInvoicePdf(payload: InvoicePdfPayload, documentType?: string, invoiceStatus: string = "issued"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: true });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const layout: InvoiceLayout = {
      ML: 45,
      MR: 45,
      PW: 595,
      CW: 595 - 45 - 45, // 505
      BLACK: "#111827",
      GRAY: "#6b7280",
      LIGHTGRAY: "#f3f4f6",
      BORDER: "#e5e7eb",
      WHITE: "#ffffff",
      FOOTER_Y: 810,
      PAGE_BOTTOM: 790,
    };

    // Determine invoice type letter.
    //
    // Priority 1 — fiscalTipo from AFIP WSFE (authoritative after CAE emission).
    //   1 = Factura A  (RI seller → RI buyer, IVA discriminado)
    //   6 = Factura B  (RI seller → consumidor final / monotributista)
    //  11 = Factura C  (Monotributista / Exento seller → any buyer)
    //  19 = Factura E  (exportación)
    //
    // Priority 2 — heuristic from seller + buyer condition (pre-CAE / legacy).
    //   RI seller + RI buyer      → "A"
    //   RI seller + other buyer   → "B"
    //   Monotributista/Exento     → "C"
    const FISCAL_TIPO_LETTER: Record<number, string> = { 1: "A", 6: "B", 11: "C", 19: "E" };
    const ivaCondition = payload.business.ivaCondition ?? "Monotributista";
    const buyerCondition = payload.customer.taxCondition ?? "";
    let invoiceLetter: string;
    if (payload.fiscalTipo != null && FISCAL_TIPO_LETTER[payload.fiscalTipo]) {
      invoiceLetter = FISCAL_TIPO_LETTER[payload.fiscalTipo];
    } else if (ivaCondition === "Responsable Inscripto") {
      invoiceLetter = buyerCondition === "Responsable Inscripto" ? "A" : "B";
    } else {
      invoiceLetter = "C";
    }

    const dateLabel = new Date(payload.sale.date).toLocaleDateString("es-AR", {
      day: "2-digit", month: "2-digit", year: "numeric",
    });

    // Parse invoice number: "FC-0001-00000001" / "REC-0001-00000001" (3 parts)
    // or legacy "0001-00000001" (2 parts, no prefix)
    const invParts = payload.sale.invoiceNumber.split("-");
    const ptoVenta = invParts.length >= 3 ? (invParts[1] ?? "0001") : (invParts[0] ?? "0001");
    const nroComp  = invParts.length >= 3 ? (invParts[2] ?? "00000001") : (invParts[1] ?? "00000001");

    const statusLabel = STATUS_LABELS[invoiceStatus] ?? invoiceStatus;

    // Resolve document type — payload field takes precedence over the parameter,
    // parameter takes precedence over the "receipt" default.
    // This allows callers to set documentType on the payload itself (preferred)
    // or pass it explicitly to buildInvoicePdf for backwards compatibility.
    // Per AFIP 2026: only "invoice" renders the Factura header + CAE block.
    // "receipt" renders "COMPROBANTE / sin validez fiscal" — no CAE, no AFIP QR.
    // References: AFIP RG 2485 (CAE mandatory on Factura), RG 4291/2018 (QR on Factura).
    const resolvedDocumentType = payload.documentType ?? documentType ?? "receipt";
    const isInvoice = resolvedDocumentType === "invoice";

    // ── HEADER ─────────────────────────────────────────────────────────────
    const { headerTop, headerH } = drawInvoiceHeader(doc, payload, layout, {
      isInvoice,
      invoiceLetter,
      ivaCondition,
      ptoVenta,
      nroComp,
      dateLabel,
      statusLabel,
    });

    // ── CUSTOMER ───────────────────────────────────────────────────────────
    const { custTop, custH } = drawInvoiceCustomer(doc, payload, layout, headerTop + headerH);

    // ── ITEMS TABLE ────────────────────────────────────────────────────────
    const { rowY } = drawInvoiceItems(doc, payload, layout, custTop + custH, isInvoice);

    // ── TOTALS + FOOTER ────────────────────────────────────────────────────
    // drawInvoiceTotalsAndFooter is async when fiscalQrUrl is present (QR PNG generation).
    drawInvoiceTotalsAndFooter(doc, payload, layout, rowY)
      .then(() => doc.end())
      .catch(reject);
  });
}
