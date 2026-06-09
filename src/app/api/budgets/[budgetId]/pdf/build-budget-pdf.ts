import PDFDocument from "pdfkit";
import { drawBudgetHeader } from "./budget-pdf-header";
import { drawBudgetCustomer } from "./budget-pdf-customer";
import { drawBudgetItems } from "./budget-pdf-items";
import { drawBudgetTotalsAndFooter } from "./budget-pdf-totals";
import type { BudgetLayout, BudgetPdfData } from "./budget-pdf-types";

export type { BudgetPdfData } from "./budget-pdf-types";

export function buildBudgetPdf(data: BudgetPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const layout: BudgetLayout = {
      ML: 45,
      MR: 45,
      PW: 595,
      CW: 595 - 45 - 45,
      BLACK: "#111827",
      GRAY: "#6b7280",
      LIGHTGRAY: "#f3f4f6",
      BORDER: "#e5e7eb",
      WHITE: "#ffffff",
      FOOTER_Y: 810,
      PAGE_BOTTOM: 790,
    };

    const dateLabel = new Date(data.createdAt).toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    const validUntil = new Date(data.createdAt);
    validUntil.setDate(validUntil.getDate() + 30);
    const validUntilLabel = validUntil.toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    // ── HEADER ─────────────────────────────────────────────────────────────
    const { headerTop, headerH } = drawBudgetHeader(doc, data, layout, {
      dateLabel,
      validUntilLabel,
    });

    // ── CUSTOMER ───────────────────────────────────────────────────────────
    const { custTop, custH } = drawBudgetCustomer(doc, data, layout, headerTop + headerH);

    // ── ITEMS TABLE ────────────────────────────────────────────────────────
    const { rowY } = drawBudgetItems(doc, data, layout, custTop + custH);

    // ── TOTALS + CONDITIONS + FOOTER ───────────────────────────────────────
    drawBudgetTotalsAndFooter(doc, data, layout, rowY);

    doc.end();
  });
}
