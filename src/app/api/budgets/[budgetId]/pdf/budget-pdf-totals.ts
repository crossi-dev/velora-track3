import type PDFDocument from "pdfkit";
import type { BudgetPdfData, BudgetLayout } from "./budget-pdf-types";
import { formatMoney, drawBudgetPageFooter } from "./budget-pdf-items";

export function drawBudgetTotalsAndFooter(
  doc: InstanceType<typeof PDFDocument>,
  data: BudgetPdfData,
  layout: BudgetLayout,
  rowY: number,
): void {
  const { ML, CW, BLACK, GRAY, BORDER, WHITE } = layout;

  // ── SUBTOTAL + SHIPPING (only when shipping is populated) ──────────────
  // Pattern mirrors Stripe Checkout / Shopify Order summary:
  //   Subtotal → Envío → Total. Items table totals into subtotal.
  let cursorY = rowY + 8;
  const summaryBoxW = 180;
  const summaryBoxX = ML + CW - summaryBoxW;

  if (data.shippingCost !== null) {
    const subtotal = data.total - data.shippingCost;
    const lineH = 16;

    doc.fontSize(8.5).fillColor(GRAY).font("Helvetica")
      .text("Subtotal", summaryBoxX, cursorY, { width: 100, align: "left" });
    doc.fontSize(8.5).fillColor(BLACK).font("Helvetica")
      .text(formatMoney(subtotal, data.currency), summaryBoxX + 80, cursorY, {
        width: summaryBoxW - 80, align: "right",
      });
    cursorY += lineH;

    doc.fontSize(8.5).fillColor(GRAY).font("Helvetica")
      .text("Envío", summaryBoxX, cursorY, { width: 100, align: "left" });
    doc.fontSize(8.5).fillColor(BLACK).font("Helvetica")
      .text(formatMoney(data.shippingCost, data.currency), summaryBoxX + 80, cursorY, {
        width: summaryBoxW - 80, align: "right",
      });
    cursorY += lineH + 4;
  }

  // ── TOTAL ───────────────────────────────────────────────────────────────
  const totalY = cursorY;
  doc.rect(summaryBoxX, totalY, summaryBoxW, 28).fill(BLACK);
  doc
    .fontSize(8.5)
    .fillColor("#9ca3af")
    .font("Helvetica")
    .text("TOTAL", summaryBoxX + 10, totalY + 9);
  doc
    .fontSize(12)
    .fillColor(WHITE)
    .font("Helvetica-Bold")
    .text(formatMoney(data.total, data.currency), summaryBoxX + 10, totalY + 8, {
      width: summaryBoxW - 16,
      align: "right",
    });

  // ── PAY ONLINE (only when paymentLinkUrl present) ──────────────────────
  // Industry-standard quote-to-payment pattern: Stripe Quotes embed the
  // checkout link directly in the rendered document so the buyer can pay
  // without opening a separate channel.
  // Source: https://docs.stripe.com/payments/quotes
  let payBoxBottom = totalY + 44;
  if (data.paymentLinkUrl) {
    const payBoxY = totalY + 36;
    const payBoxH = 38;
    doc.rect(ML, payBoxY, CW, payBoxH).fill("#f0fdf4").stroke("#22c55e");
    doc.fontSize(8.5).fillColor("#15803d").font("Helvetica-Bold")
      .text("Pagá online", ML + 10, payBoxY + 8);
    doc.fontSize(8).fillColor("#15803d").font("Helvetica")
      .text(
        "Hacé click acá para completar el pago de forma segura con MercadoPago:",
        ML + 10, payBoxY + 20, { width: CW - 20 },
      );
    doc.fontSize(8).fillColor("#1d4ed8").font("Helvetica")
      .text(data.paymentLinkUrl, ML + 10, payBoxY + 28, {
        width: CW - 20,
        link: data.paymentLinkUrl,
        underline: true,
      });
    payBoxBottom = payBoxY + payBoxH + 8;
  }

  // ── CONDITIONS ──────────────────────────────────────────────────────────
  const condY = payBoxBottom;
  doc.rect(ML, condY, CW, 36).stroke(BORDER);
  doc
    .fontSize(7.5)
    .fillColor(GRAY)
    .font("Helvetica-Bold")
    .text("Condiciones:", ML + 8, condY + 8);
  doc
    .fontSize(7.5)
    .fillColor(GRAY)
    .font("Helvetica")
    .text(
      "Precios sujetos a modificacion sin previo aviso. Este presupuesto no es un comprobante fiscal.",
      ML + 8,
      condY + 20,
      { width: CW - 16 }
    );

  // ── FOOTER ──────────────────────────────────────────────────────────────
  drawBudgetPageFooter(doc, data, layout);
}
