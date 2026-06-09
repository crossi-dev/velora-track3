import type PDFDocument from "pdfkit";
import type { InvoicePdfPayload, InvoiceLayout } from "./invoice-pdf-types";
import { formatMoney } from "./invoice-pdf-items";
import { drawFiscalComplianceBlock, FISCAL_BLOCK_H } from "./invoice-pdf-fiscal";

export async function drawInvoiceTotalsAndFooter(
  doc: InstanceType<typeof PDFDocument>,
  payload: InvoicePdfPayload,
  layout: InvoiceLayout,
  rowY: number,
): Promise<void> {
  const { ML, CW, BLACK, GRAY, LIGHTGRAY, BORDER, WHITE, FOOTER_Y } = layout;

  const taxRate = typeof payload.business.taxRate === "number" && payload.business.taxRate > 0
    ? payload.business.taxRate
    : null;

  const totalY = rowY + 8;
  const totalBoxW = 180;
  const totalBoxX = ML + CW - totalBoxW;

  if (taxRate !== null) {
    const subtotalBeforeTax = payload.sale.total / (1 + taxRate / 100);
    const ivaAmount = payload.sale.total - subtotalBeforeTax;

    const subtotalRowH = 20;
    doc.rect(totalBoxX, totalY, totalBoxW, subtotalRowH).fill(LIGHTGRAY).stroke(BORDER);
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica")
      .text("Subtotal:", totalBoxX + 10, totalY + 6);
    doc
      .fontSize(8)
      .fillColor(BLACK)
      .font("Helvetica-Bold")
      .text(
        formatMoney(subtotalBeforeTax, payload.business.currency),
        totalBoxX + 10,
        totalY + 6,
        { width: totalBoxW - 16, align: "right" }
      );

    const ivaRowY = totalY + subtotalRowH;
    doc.rect(totalBoxX, ivaRowY, totalBoxW, subtotalRowH).fill(LIGHTGRAY).stroke(BORDER);
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica")
      .text(`IVA ${taxRate}%:`, totalBoxX + 10, ivaRowY + 6);
    doc
      .fontSize(8)
      .fillColor(BLACK)
      .font("Helvetica-Bold")
      .text(
        formatMoney(ivaAmount, payload.business.currency),
        totalBoxX + 10,
        ivaRowY + 6,
        { width: totalBoxW - 16, align: "right" }
      );

    const totalBoxY = ivaRowY + subtotalRowH;
    doc.rect(totalBoxX, totalBoxY, totalBoxW, 28).fill(BLACK);
    doc
      .fontSize(8.5)
      .fillColor("#9ca3af")
      .font("Helvetica")
      .text("TOTAL", totalBoxX + 10, totalBoxY + 9);
    doc
      .fontSize(12)
      .fillColor(WHITE)
      .font("Helvetica-Bold")
      .text(
        formatMoney(payload.sale.total, payload.business.currency),
        totalBoxX + 10,
        totalBoxY + 8,
        { width: totalBoxW - 16, align: "right" }
      );

    const disclaimerY = totalBoxY + 44;
    {
      doc.rect(ML, disclaimerY, CW, 24).stroke(BORDER);
      doc
        .fontSize(7.5)
        .fillColor(GRAY)
        .font("Helvetica-Bold")
        .text("COMPROBANTE DE VENTA", ML, disclaimerY + 8, { width: CW, align: "center" });
    }

    // ── FISCAL COMPLIANCE BLOCK (RG 2485 + RG 4291) — only for real CAE invoices
    const fiscalBlockY1 = disclaimerY + 32;
    await drawFiscalComplianceBlock(doc, payload, layout, fiscalBlockY1);
    const footerY1 = payload.caeCode ? fiscalBlockY1 + FISCAL_BLOCK_H + 6 : FOOTER_Y;
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica")
      .text("Comprobante creado en Velora · Tu negocio AI · velora.app", ML, footerY1, { width: CW, align: "center" });
  } else {
    doc.rect(totalBoxX, totalY, totalBoxW, 28).fill(BLACK);
    doc
      .fontSize(8.5)
      .fillColor("#9ca3af")
      .font("Helvetica")
      .text("TOTAL", totalBoxX + 10, totalY + 9);
    doc
      .fontSize(12)
      .fillColor(WHITE)
      .font("Helvetica-Bold")
      .text(
        formatMoney(payload.sale.total, payload.business.currency),
        totalBoxX + 10,
        totalY + 8,
        { width: totalBoxW - 16, align: "right" }
      );

    const disclaimerY = totalY + 44;
    doc.rect(ML, disclaimerY, CW, 24).stroke(BORDER);
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica-Bold")
      .text("COMPROBANTE DE VENTA", ML, disclaimerY + 8, { width: CW, align: "center" });

    // ── FISCAL COMPLIANCE BLOCK (RG 2485 + RG 4291) — only for real CAE invoices
    const fiscalBlockY2 = disclaimerY + 32;
    await drawFiscalComplianceBlock(doc, payload, layout, fiscalBlockY2);
    const footerY2 = payload.caeCode ? fiscalBlockY2 + FISCAL_BLOCK_H + 6 : FOOTER_Y;
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica")
      .text("Comprobante creado en Velora · Tu negocio AI · velora.app", ML, footerY2, { width: CW, align: "center" });
  }
}
