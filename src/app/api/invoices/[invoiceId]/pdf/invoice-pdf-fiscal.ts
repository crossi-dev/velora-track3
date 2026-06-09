// invoice-pdf-fiscal.ts — AFIP compliance block for electronic invoice PDFs.
//
// Renders the mandatory fiscal section below the TOTAL box per:
//   RG 2485: CAE code + CAE expiry date must be visible on the printed comprobante.
//   RG 4291/2018: A QR code encoding the invoice + CAE data must appear on the PDF.
//
// This module is only activated when payload.caeCode is present (real WSFE emission).
// Sandbox and non-fiscal receipts skip this block entirely — no rendering at all.

import type PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type { InvoicePdfPayload, InvoiceLayout } from "./invoice-pdf-types";

/** Height in PDF points of the fiscal compliance block (CAE text + QR). */
export const FISCAL_BLOCK_H = 88;

/**
 * Draws the AFIP fiscal compliance section below the given `blockY` coordinate.
 *
 * Layout (left-to-right within content width):
 *   [CAE label + value + Vto label + value]  |  [QR image 70×70 pt]
 *
 * Returns early (no drawing) when payload.caeCode is absent.
 *
 * @param doc     Active PDFDocument instance.
 * @param payload Invoice payload — reads caeCode, caeFchVto, fiscalQrUrl.
 * @param layout  Shared layout constants (ML, CW, etc.).
 * @param blockY  Y coordinate where this block should start.
 */
export async function drawFiscalComplianceBlock(
  doc: InstanceType<typeof PDFDocument>,
  payload: InvoicePdfPayload,
  layout: InvoiceLayout,
  blockY: number,
): Promise<void> {
  if (!payload.caeCode) return;

  const { ML, CW, GRAY, BLACK, BORDER, LIGHTGRAY } = layout;

  // ── Background box ────────────────────────────────────────────────────────
  doc.rect(ML, blockY, CW, FISCAL_BLOCK_H).fill(LIGHTGRAY).stroke(BORDER);

  // ── CAE text block (left side) ────────────────────────────────────────────
  const textX = ML + 10;
  const textW = CW - 90; // leave room for the QR on the right

  doc
    .fontSize(7)
    .fillColor(GRAY)
    .font("Helvetica")
    .text("CAE:", textX, blockY + 10);

  doc
    .fontSize(8.5)
    .fillColor(BLACK)
    .font("Helvetica-Bold")
    .text(payload.caeCode, textX, blockY + 20);

  // Vto. CAE — format as dd/MM/yyyy (RG 2485 requirement)
  const vtoLabel = formatCaeExpiry(payload.caeFchVto ?? null);
  doc
    .fontSize(7)
    .fillColor(GRAY)
    .font("Helvetica")
    .text("Vto. CAE:", textX, blockY + 36);

  doc
    .fontSize(8.5)
    .fillColor(BLACK)
    .font("Helvetica-Bold")
    .text(vtoLabel, textX, blockY + 46);

  doc
    .fontSize(6.5)
    .fillColor(GRAY)
    .font("Helvetica")
    .text(
      "Comprobante autorizado por ARCA (ex-AFIP) — RG 2485 / RG 4291",
      textX,
      blockY + 64,
      { width: textW },
    );

  // ── QR image (right side) ────────────────────────────────────────────────
  if (payload.fiscalQrUrl) {
    const qrSize = 70; // points (~24.7 mm — compliant with AFIP minimum)
    const qrX = ML + CW - qrSize - 10;
    const qrY = blockY + 9;

    try {
      const qrBuffer = await QRCode.toBuffer(payload.fiscalQrUrl, {
        type: "png",
        width: 200, // px — rendered into qrSize pt
        margin: 1,
        errorCorrectionLevel: "M",
      });
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
    } catch {
      // If QR generation fails, draw a placeholder box so the PDF still renders.
      doc.rect(qrX, qrY, qrSize, qrSize).stroke(BORDER);
      doc
        .fontSize(6)
        .fillColor(GRAY)
        .text("QR no disponible", qrX + 5, qrY + qrSize / 2 - 3, { width: qrSize - 10, align: "center" });
    }
  }
}

/** Formats an ISO-8601 UTC date string as dd/MM/yyyy (Argentine locale). */
function formatCaeExpiry(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}
