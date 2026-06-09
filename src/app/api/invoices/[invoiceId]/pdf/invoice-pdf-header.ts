import type PDFDocument from "pdfkit";
import type { InvoicePdfPayload, InvoiceLayout, InvoiceHeaderContext } from "./invoice-pdf-types";

export type { InvoiceLayout, InvoiceHeaderContext } from "./invoice-pdf-types";

export function drawInvoiceHeader(
  doc: InstanceType<typeof PDFDocument>,
  payload: InvoicePdfPayload,
  layout: InvoiceLayout,
  ctx: InvoiceHeaderContext,
): { headerTop: number; headerH: number } {
  const { ML, CW, BLACK, GRAY, BORDER } = layout;
  const { isInvoice, invoiceLetter, ivaCondition, ptoVenta, nroComp, dateLabel, statusLabel } = ctx;

  const headerTop = 40;
  const headerH = 110;
  const centerBoxW = 60;
  const sideW = (CW - centerBoxW - 2 * 8) / 2; // ~210px each side

  const leftX = ML;
  const centerX = ML + sideW + 8;
  const rightX = centerX + centerBoxW + 8;

  // Outer border around entire header
  doc.rect(ML, headerTop, CW, headerH).stroke(BORDER);

  // Center letter box
  doc.rect(centerX, headerTop, centerBoxW, headerH).stroke(BORDER);
  if (isInvoice) {
    doc
      .fontSize(48)
      .fillColor(BLACK)
      .font("Helvetica-Bold")
      .text(invoiceLetter, centerX, headerTop + 18, { width: centerBoxW, align: "center" });
    doc
      .fontSize(7)
      .fillColor(GRAY)
      .font("Helvetica")
      .text("FACTURA", centerX, headerTop + 72, { width: centerBoxW, align: "center" });
    const LETTER_AFIP_CODE: Record<string, string> = { A: "1", B: "6", C: "11", E: "19" };
    const afipCode = LETTER_AFIP_CODE[invoiceLetter] ?? "?";
    doc.text(`Cód. ${afipCode}`, centerX, headerTop + 83, { width: centerBoxW, align: "center" });
  } else {
    doc
      .fontSize(7)
      .fillColor(GRAY)
      .font("Helvetica")
      .text("COMPROBANTE", centerX, headerTop + 50, { width: centerBoxW, align: "center" });
    doc
      .fontSize(6)
      .text("sin validez fiscal", centerX, headerTop + 62, { width: centerBoxW, align: "center" });
  }

  // Left: business info
  doc
    .fontSize(11)
    .fillColor(BLACK)
    .font("Helvetica-Bold")
    .text(payload.business.name, leftX + 8, headerTop + 10, { width: sideW - 10 });

  doc.fontSize(8).fillColor(GRAY).font("Helvetica");
  let ly = headerTop + 28;
  if (payload.business.address) {
    doc.text(`Domicilio: ${payload.business.address}`, leftX + 8, ly, { width: sideW - 10 });
    ly += 12;
  }
  doc.text(`CUIT: ${payload.business.cuit ?? "-"}`, leftX + 8, ly); ly += 12;
  if (payload.business.iibb) {
    doc.text(`Ing. Brutos: ${payload.business.iibb}`, leftX + 8, ly); ly += 12;
  }
  if (payload.business.activityStart) {
    doc.text(`Inicio actividades: ${payload.business.activityStart}`, leftX + 8, ly); ly += 12;
  }
  doc.text(ivaCondition, leftX + 8, ly);

  // Right: invoice number + date + status
  doc
    .fontSize(8)
    .fillColor(GRAY)
    .font("Helvetica")
    .text("Punto de Venta:", rightX + 4, headerTop + 12)
    .text("Comp. Nro:", rightX + 4, headerTop + 26)
    .text("Fecha de emisión:", rightX + 4, headerTop + 40)
    .text("Estado:", rightX + 4, headerTop + 54);

  doc
    .fontSize(8)
    .fillColor(BLACK)
    .font("Helvetica-Bold")
    .text(ptoVenta, rightX + 4, headerTop + 12, { width: sideW - 8, align: "right" })
    .text(nroComp, rightX + 4, headerTop + 26, { width: sideW - 8, align: "right" })
    .text(dateLabel, rightX + 4, headerTop + 40, { width: sideW - 8, align: "right" })
    .text(statusLabel, rightX + 4, headerTop + 54, { width: sideW - 8, align: "right" });

  return { headerTop, headerH };
}
