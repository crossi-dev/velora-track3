import type PDFDocument from "pdfkit";
import type { BudgetPdfData, BudgetLayout, BudgetHeaderContext } from "./budget-pdf-types";

export type { BudgetLayout, BudgetHeaderContext } from "./budget-pdf-types";

export function drawBudgetHeader(
  doc: InstanceType<typeof PDFDocument>,
  data: BudgetPdfData,
  layout: BudgetLayout,
  ctx: BudgetHeaderContext,
): { headerTop: number; headerH: number } {
  const { ML, CW, BLACK, GRAY, BORDER } = layout;
  const { dateLabel, validUntilLabel } = ctx;

  const headerTop = 40;
  const headerH = 110;
  const labelColW = 80;
  const sideW = (CW - labelColW - 8) / 2;

  const leftX = ML;
  const centerX = ML + sideW + 8;
  const rightX = centerX + labelColW + 8;

  doc.rect(ML, headerTop, CW, headerH).stroke(BORDER);
  doc.rect(centerX, headerTop, labelColW, headerH).stroke(BORDER);
  doc
    .fontSize(7.5)
    .fillColor(GRAY)
    .font("Helvetica-Bold")
    .text("PRESUPUESTO", centerX, headerTop + 50, { width: labelColW, align: "center" });

  doc
    .fontSize(11)
    .fillColor(BLACK)
    .font("Helvetica-Bold")
    .text(data.businessName, leftX + 8, headerTop + 10, { width: sideW - 10 });

  doc.fontSize(8).fillColor(GRAY).font("Helvetica");
  let ly = headerTop + 28;
  if (data.businessAddress) {
    doc.text(`Domicilio: ${data.businessAddress}`, leftX + 8, ly, { width: sideW - 10 });
    ly += 12;
  }
  doc.text(`CUIT: ${data.businessCuit ?? "-"}`, leftX + 8, ly); ly += 12;
  doc.text(data.businessIvaCondition ?? "Monotributista", leftX + 8, ly);

  doc
    .fontSize(8)
    .fillColor(GRAY)
    .font("Helvetica")
    .text("Nro. Presupuesto:", rightX + 4, headerTop + 12)
    .text("Fecha:", rightX + 4, headerTop + 26)
    .text("Valido hasta:", rightX + 4, headerTop + 40);

  doc
    .fontSize(8)
    .fillColor(BLACK)
    .font("Helvetica-Bold")
    .text(data.budgetNumber, rightX + 4, headerTop + 12, { width: sideW - 8, align: "right" })
    .text(dateLabel, rightX + 4, headerTop + 26, { width: sideW - 8, align: "right" })
    .text(validUntilLabel, rightX + 4, headerTop + 40, { width: sideW - 8, align: "right" });

  return { headerTop, headerH };
}
