import type PDFDocument from "pdfkit";
import type { InvoicePdfPayload, InvoiceLayout } from "./invoice-pdf-types";

export function drawInvoiceCustomer(
  doc: InstanceType<typeof PDFDocument>,
  payload: InvoicePdfPayload,
  layout: InvoiceLayout,
  headerBottomY: number,
): { custTop: number; custH: number } {
  const { ML, CW, BLACK, GRAY, BORDER } = layout;

  const custTop = headerBottomY + 10;
  const hasEmail = !!payload.customer.email;
  const hasPhone = !!payload.customer.phone;
  const custExtraLines = (hasEmail ? 1 : 0) + (hasPhone ? 1 : 0);
  const custH = 44 + custExtraLines * 12;
  doc.rect(ML, custTop, CW, custH).stroke(BORDER);

  const isConsumidorFinal =
    !payload.customer.taxId &&
    (payload.customer.name.toLowerCase().includes("consumidor") ||
      payload.customer.name.toLowerCase().includes("final"));

  doc
    .fontSize(7)
    .fillColor(GRAY)
    .font("Helvetica-Bold")
    .text("RECEPTOR", ML + 8, custTop + 6);

  doc
    .fontSize(9)
    .fillColor(BLACK)
    .font("Helvetica-Bold")
    .text(
      isConsumidorFinal ? "Consumidor Final" : payload.customer.name,
      ML + 8,
      custTop + 17,
      { width: CW / 2 - 16 }
    );

  doc
    .fontSize(8)
    .fillColor(GRAY)
    .font("Helvetica")
    .text(
      isConsumidorFinal ? "Cond. IVA: Consumidor Final" : `CUIT/CUIL: ${payload.customer.taxId ?? "-"}`,
      ML + CW / 2,
      custTop + 17
    );

  // Extra contact info below the name row
  let custContactY = custTop + 32;
  if (hasEmail) {
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica")
      .text(`Email: ${payload.customer.email}`, ML + 8, custContactY);
    custContactY += 12;
  }
  if (hasPhone) {
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica")
      .text(`Tel: ${payload.customer.phone}`, ML + 8, custContactY);
  }

  return { custTop, custH };
}
