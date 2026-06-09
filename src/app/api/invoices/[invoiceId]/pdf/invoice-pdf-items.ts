import type PDFDocument from "pdfkit";
import type { InvoicePdfPayload, InvoiceLayout } from "./invoice-pdf-types";
import { formatMoney as canonicalFormatMoney } from "@/lib/format/money";

// Invoice PDF style: ISO-prefix (e.g. "ARS 1.200,50") with 2 decimals.
// Re-exported because other PDF modules consume it from here.
export function formatMoney(value: number, currency: string): string {
  return canonicalFormatMoney(value, currency, { style: "iso-prefix", decimals: 2 });
}

export function drawInvoiceItems(
  doc: InstanceType<typeof PDFDocument>,
  payload: InvoicePdfPayload,
  layout: InvoiceLayout,
  custBottomY: number,
  isInvoice: boolean,
): { rowY: number } {
  const { ML, CW, BLACK, GRAY, LIGHTGRAY, BORDER, WHITE, FOOTER_Y, PAGE_BOTTOM } = layout;

  const colDesc = ML;
  const colQty = ML + 320;
  const colUnit = ML + 380;
  const colSub = ML + 440;
  const colWidths = { desc: 315, qty: 55, unit: 55, sub: 60 };
  const ROW_H = 18;
  const TABLE_HEADER_H = 20;
  const TAIL_RESERVE = 28 + 8 + 44 + 16;

  function drawTableHeader(ty: number) {
    doc.rect(ML, ty, CW, TABLE_HEADER_H).fill(BLACK);
    doc
      .fontSize(7.5)
      .fillColor(WHITE)
      .font("Helvetica-Bold")
      .text("DESCRIPCION", colDesc + 6, ty + 6)
      .text("CANT.", colQty, ty + 6, { width: colWidths.qty, align: "right" })
      .text("P. UNIT.", colUnit, ty + 6, { width: colWidths.unit, align: "right" })
      .text("SUBTOTAL", colSub, ty + 6, { width: colWidths.sub - 4, align: "right" });
    return ty + TABLE_HEADER_H;
  }

  let tableTop = custBottomY + 12;
  let rowY = drawTableHeader(tableTop);

  // Merge product items + optional shipping line into a single flat list so
  // the table renderer handles pagination uniformly without special-casing.
  const shippingLine = payload.sale.shippingLine;
  const allRows: Array<{ productName: string; quantity: number; unitPrice: number; subtotal: number }> = [
    ...payload.sale.items,
    ...(shippingLine
      ? [{ productName: `Envío ${shippingLine.courier}`, quantity: 1, unitPrice: shippingLine.costARS, subtotal: shippingLine.costARS }]
      : []),
  ];

  let rowParity = 0;
  for (let i = 0; i < allRows.length; i++) {
    const item = allRows[i]!;

    const needsTail = i === allRows.length - 1;
    const spaceNeeded = ROW_H + (needsTail ? TAIL_RESERVE : 0);
    if (rowY + spaceNeeded > PAGE_BOTTOM) {
      doc
        .fontSize(7.5)
        .fillColor(GRAY)
        .font("Helvetica")
        .text(`${isInvoice ? "Factura" : "Comprobante"} creado en Velora · Tu negocio AI · velora.app`, ML, FOOTER_Y, { width: CW, align: "center" });

      doc.addPage();
      tableTop = 40;
      rowY = drawTableHeader(tableTop);
      rowParity = 0;
    }

    const bg = rowParity % 2 === 0 ? WHITE : LIGHTGRAY;
    rowParity++;
    doc.rect(ML, rowY, CW, ROW_H).fill(bg);
    doc.rect(ML, rowY, CW, ROW_H).stroke(BORDER);

    const rawName = item.productName ?? "";
    const displayName = rawName.length > 60 ? rawName.slice(0, 57) + "..." : rawName;

    doc
      .fontSize(8)
      .fillColor(BLACK)
      .font("Helvetica")
      .text(displayName, colDesc + 6, rowY + 5, { width: colWidths.desc - 10, lineBreak: false })
      .text(String(item.quantity), colQty, rowY + 5, { width: colWidths.qty, align: "right", lineBreak: false })
      .text(formatMoney(item.unitPrice, payload.business.currency), colUnit, rowY + 5, { width: colWidths.unit, align: "right", lineBreak: false })
      .text(formatMoney(item.subtotal, payload.business.currency), colSub, rowY + 5, { width: colWidths.sub - 4, align: "right", lineBreak: false });

    rowY += ROW_H;
  }

  if (allRows.length === 0) {
    doc.rect(ML, rowY, CW, ROW_H).fill(WHITE).stroke(BORDER);
    doc
      .fontSize(8)
      .fillColor(GRAY)
      .font("Helvetica")
      .text("Sin items", colDesc + 6, rowY + 5);
    rowY += ROW_H;
  }

  return { rowY };
}
