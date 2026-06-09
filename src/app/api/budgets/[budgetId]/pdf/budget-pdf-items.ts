import type PDFDocument from "pdfkit";
import type { BudgetPdfData, BudgetLayout } from "./budget-pdf-types";
import { formatMoney } from "@/lib/format/money";

export { formatMoney };

export function drawBudgetPageFooter(
  doc: InstanceType<typeof PDFDocument>,
  data: BudgetPdfData,
  layout: BudgetLayout,
): void {
  const { ML, CW, GRAY, FOOTER_Y } = layout;
  const contactParts: string[] = [];
  if (data.businessPhone) contactParts.push(`Tel: ${data.businessPhone}`);
  if (data.businessWhatsapp) contactParts.push(`WhatsApp: ${data.businessWhatsapp}`);
  const contactLine = contactParts.join("  ·  ");
  if (contactLine) {
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica")
      .text(contactLine, ML, FOOTER_Y - 14, { width: CW, align: "center" });
  }
  doc
    .fontSize(7.5)
    .fillColor(GRAY)
    .font("Helvetica")
    .text("Presupuesto creado en Velora · Tu negocio AI · velora.app", ML, FOOTER_Y, {
      width: CW,
      align: "center",
    });
}

export function drawBudgetItems(
  doc: InstanceType<typeof PDFDocument>,
  data: BudgetPdfData,
  layout: BudgetLayout,
  custBottomY: number,
): { rowY: number } {
  const { ML, CW, BLACK, GRAY, LIGHTGRAY, BORDER, WHITE, PAGE_BOTTOM } = layout;

  const colDesc = ML;
  const colQty = ML + 320;
  const colUnit = ML + 380;
  const colSub = ML + 440;
  const colWidths = { desc: 315, qty: 55, unit: 55, sub: 60 };
  const ROW_H = 18;
  const TABLE_HEADER_H = 20;
  const TAIL_RESERVE = 28 + 8 + 36 + 60;

  function drawTableHeader(ty: number) {
    doc.rect(ML, ty, CW, TABLE_HEADER_H).fill(BLACK);
    doc
      .fontSize(7.5)
      .fillColor(WHITE)
      .font("Helvetica-Bold")
      .text("PRODUCTO", colDesc + 6, ty + 6)
      .text("CANT.", colQty, ty + 6, { width: colWidths.qty, align: "right" })
      .text("PRECIO UNIT.", colUnit, ty + 6, { width: colWidths.unit, align: "right" })
      .text("SUBTOTAL", colSub, ty + 6, { width: colWidths.sub - 4, align: "right" });
    return ty + TABLE_HEADER_H;
  }

  let tableTop = custBottomY + 12;
  let rowY = drawTableHeader(tableTop);

  let rowParity = 0;
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i]!;

    const needsTail = i === data.items.length - 1;
    const spaceNeeded = ROW_H + (needsTail ? TAIL_RESERVE : 0);
    if (rowY + spaceNeeded > PAGE_BOTTOM) {
      drawBudgetPageFooter(doc, data, layout);
      doc.addPage();
      tableTop = 40;
      rowY = drawTableHeader(tableTop);
      rowParity = 0;
    }

    const bg = rowParity % 2 === 0 ? WHITE : LIGHTGRAY;
    rowParity++;
    doc.rect(ML, rowY, CW, ROW_H).fill(bg);
    doc.rect(ML, rowY, CW, ROW_H).stroke(BORDER);

    const rawName = item.name ?? "";
    const displayName = rawName.length > 60 ? rawName.slice(0, 57) + "..." : rawName;

    doc
      .fontSize(8)
      .fillColor(BLACK)
      .font("Helvetica")
      .text(displayName, colDesc + 6, rowY + 5, { width: colWidths.desc - 10, lineBreak: false })
      .text(String(item.quantity), colQty, rowY + 5, { width: colWidths.qty, align: "right", lineBreak: false })
      .text(formatMoney(item.unitPrice, data.currency), colUnit, rowY + 5, { width: colWidths.unit, align: "right", lineBreak: false })
      .text(formatMoney(item.subtotal, data.currency), colSub, rowY + 5, { width: colWidths.sub - 4, align: "right", lineBreak: false });

    rowY += ROW_H;
  }

  if (data.items.length === 0) {
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
