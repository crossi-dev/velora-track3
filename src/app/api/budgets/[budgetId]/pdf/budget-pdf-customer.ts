import type PDFDocument from "pdfkit";
import type { BudgetPdfData, BudgetLayout } from "./budget-pdf-types";

export function drawBudgetCustomer(
  doc: InstanceType<typeof PDFDocument>,
  data: BudgetPdfData,
  layout: BudgetLayout,
  headerBottomY: number,
): { custTop: number; custH: number } {
  const { ML, CW, BLACK, GRAY, BORDER } = layout;

  const custTop = headerBottomY + 10;
  const hasEmail = !!data.customerEmail;
  const hasPhone = !!data.customerPhone;
  const custExtraLines = (hasEmail ? 1 : 0) + (hasPhone ? 1 : 0);
  const custH = data.customerName ? 44 + custExtraLines * 12 : 30;

  doc.rect(ML, custTop, CW, custH).stroke(BORDER);

  doc
    .fontSize(7)
    .fillColor(GRAY)
    .font("Helvetica-Bold")
    .text("CLIENTE", ML + 8, custTop + 6);

  if (data.customerName) {
    doc
      .fontSize(9)
      .fillColor(BLACK)
      .font("Helvetica-Bold")
      .text(data.customerName, ML + 8, custTop + 17, { width: CW / 2 - 16 });

    if (data.customerTaxId) {
      doc
        .fontSize(8)
        .fillColor(GRAY)
        .font("Helvetica")
        .text(`CUIT/CUIL: ${data.customerTaxId}`, ML + CW / 2, custTop + 17);
    }

    let custContactY = custTop + 32;
    if (hasEmail) {
      doc
        .fontSize(7.5)
        .fillColor(GRAY)
        .font("Helvetica")
        .text(`Email: ${data.customerEmail}`, ML + 8, custContactY);
      custContactY += 12;
    }
    if (hasPhone) {
      doc
        .fontSize(7.5)
        .fillColor(GRAY)
        .font("Helvetica")
        .text(`Tel: ${data.customerPhone}`, ML + 8, custContactY);
    }
  } else {
    doc
      .fontSize(8)
      .fillColor(GRAY)
      .font("Helvetica")
      .text("Consumidor Final", ML + 8, custTop + 17);
  }

  return { custTop, custH };
}
