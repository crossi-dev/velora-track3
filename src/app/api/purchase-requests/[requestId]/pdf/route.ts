import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import PDFDocument from "pdfkit";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";
import { validatePdfAccessToken } from "@/app/api/_lib/pdf-access";
import { cloudLog } from "@/lib/cloud-logger";
import { formatMoney } from "@/lib/format/money";

interface PurchaseRequestPayload {
  business: {
    name: string;
    cuit: string | null;
    address: string | null;
    currency: string;
  };
  supplier: {
    name: string;
    email?: string | null;
    taxId?: string | null;
    phone: string | null;
    contactName: string | null;
  };
  request: {
    id: string;
    requestNumber: string;
    date: string;
    items: Array<{
      itemName: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }>;
    total: number;
  };
}

function buildPdf(payload: PurchaseRequestPayload): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const ML = 45;
    const MR = 45;
    const PW = 595;
    const CW = PW - ML - MR;
    const BLACK = "#111827";
    const GRAY = "#6b7280";
    const LIGHTGRAY = "#f3f4f6";
    const BORDER = "#e5e7eb";
    const WHITE = "#ffffff";
    const FOOTER_Y = 810;
    const PAGE_BOTTOM = 790; // last usable y before footer area

    const dateLabel = new Date(payload.request.date).toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    // ── HEADER: two-column layout ──────────────────────────────────────────
    // Left: business info | Center label box | Right: request data
    const headerTop = 40;
    const headerH = 110;
    const labelColW = 80;
    const sideW = (CW - labelColW - 8) / 2;

    const leftX = ML;
    const centerX = ML + sideW + 8;
    const rightX = centerX + labelColW + 8;

    doc.rect(ML, headerTop, CW, headerH).stroke(BORDER);

    // Center label box
    doc.rect(centerX, headerTop, labelColW, headerH).stroke(BORDER);
    doc
      .fontSize(7)
      .fillColor(GRAY)
      .font("Helvetica-Bold")
      .text("ORDEN DE", centerX, headerTop + 44, { width: labelColW, align: "center" });
    doc
      .fontSize(7)
      .fillColor(GRAY)
      .font("Helvetica-Bold")
      .text("COMPRA", centerX, headerTop + 54, { width: labelColW, align: "center" });

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
    doc.text(`CUIT: ${payload.business.cuit ?? "-"}`, leftX + 8, ly);

    // Right: request number + date
    doc
      .fontSize(8)
      .fillColor(GRAY)
      .font("Helvetica")
      .text("Nro. Orden:", rightX + 4, headerTop + 12)
      .text("Fecha:", rightX + 4, headerTop + 26);

    doc
      .fontSize(8)
      .fillColor(BLACK)
      .font("Helvetica-Bold")
      .text(payload.request.requestNumber, rightX + 4, headerTop + 12, { width: sideW - 8, align: "right" })
      .text(dateLabel, rightX + 4, headerTop + 26, { width: sideW - 8, align: "right" });

    // ── SUPPLIER ROW ────────────────────────────────────────────────────────
    const supplierTop = headerTop + headerH + 10;

    // Determine how many supplier lines we have
    const supplierLines: Array<{ label: string; value: string }> = [
      { label: "Proveedor:", value: payload.supplier.name },
    ];
    if (payload.supplier.contactName) {
      supplierLines.push({ label: "Contacto:", value: payload.supplier.contactName });
    }
    if (payload.supplier.email) {
      supplierLines.push({ label: "Email:", value: payload.supplier.email });
    }
    if (payload.supplier.taxId) {
      supplierLines.push({ label: "CUIT/RUT:", value: payload.supplier.taxId });
    }
    if (payload.supplier.phone) {
      supplierLines.push({ label: "Teléfono:", value: payload.supplier.phone });
    }

    const supplierH = 24 + supplierLines.length * 14;
    doc.rect(ML, supplierTop, CW, supplierH).stroke(BORDER);

    doc
      .fontSize(7)
      .fillColor(GRAY)
      .font("Helvetica-Bold")
      .text("PROVEEDOR", ML + 8, supplierTop + 6);

    const halfCW = CW / 2;
    for (let i = 0; i < supplierLines.length; i++) {
      const line = supplierLines[i]!;
      const col = i < Math.ceil(supplierLines.length / 2) ? 0 : 1;
      const lineIndex = col === 0 ? i : i - Math.ceil(supplierLines.length / 2);
      const xPos = ML + 8 + col * halfCW;
      const yPos = supplierTop + 18 + lineIndex * 14;
      doc
        .fontSize(7.5)
        .fillColor(GRAY)
        .font("Helvetica")
        .text(line.label, xPos, yPos)
        .fontSize(8)
        .fillColor(BLACK)
        .font("Helvetica-Bold")
        .text(line.value, xPos + 58, yPos, { width: halfCW - 66 });
    }

    // ── ITEMS TABLE ─────────────────────────────────────────────────────────
    const colDesc = ML;
    const colQty = ML + 300;
    const colUnit = ML + 370;
    const colSub = ML + 440;
    const colWidths = { desc: 295, qty: 65, unit: 65, sub: 60 };
    const ROW_H = 18;
    const TABLE_HEADER_H = 20;
    // Space reserved after last row: total box (28) + gap (8) + disclaimer (24) + gap (16) + footer
    const TAIL_RESERVE = 28 + 8 + 24 + 32;

    function drawTableHeader(ty: number) {
      doc.rect(ML, ty, CW, TABLE_HEADER_H).fill(BLACK);
      doc
        .fontSize(7.5)
        .fillColor(WHITE)
        .font("Helvetica-Bold")
        .text("ÍTEM / DESCRIPCIÓN", colDesc + 6, ty + 6)
        .text("CANT.", colQty, ty + 6, { width: colWidths.qty, align: "right" })
        .text("P. UNIT.", colUnit, ty + 6, { width: colWidths.unit, align: "right" })
        .text("SUBTOTAL", colSub, ty + 6, { width: colWidths.sub - 4, align: "right" });
      return ty + TABLE_HEADER_H;
    }

    let tableTop = supplierTop + supplierH + 12;
    let rowY = drawTableHeader(tableTop);

    let rowParity = 0;
    for (let i = 0; i < payload.request.items.length; i++) {
      const item = payload.request.items[i]!;

      const needsTail = i === payload.request.items.length - 1;
      const spaceNeeded = ROW_H + (needsTail ? TAIL_RESERVE : 0);
      if (rowY + spaceNeeded > PAGE_BOTTOM) {
        // Draw footer on current page before break
        doc
          .fontSize(7.5)
          .fillColor(GRAY)
          .font("Helvetica")
          .text("Orden de compra creada en Velora · Tu negocio AI · velora.app", ML, FOOTER_Y, {
            width: CW,
            align: "center",
          });
        doc.addPage();
        tableTop = 40;
        rowY = drawTableHeader(tableTop);
        rowParity = 0;
      }

      const bg = rowParity % 2 === 0 ? WHITE : LIGHTGRAY;
      rowParity++;
      doc.rect(ML, rowY, CW, ROW_H).fill(bg);
      doc.rect(ML, rowY, CW, ROW_H).stroke(BORDER);

      // Truncate long item names to prevent row height overflow
      const rawName = item.itemName ?? "";
      const displayName = rawName.length > 55 ? rawName.slice(0, 52) + "…" : rawName;

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

    // Empty-items fallback
    if (payload.request.items.length === 0) {
      doc.rect(ML, rowY, CW, ROW_H).fill(WHITE).stroke(BORDER);
      doc
        .fontSize(8)
        .fillColor(GRAY)
        .font("Helvetica")
        .text("Sin ítems", colDesc + 6, rowY + 5);
      rowY += ROW_H;
    }

    // ── TOTAL ───────────────────────────────────────────────────────────────
    const totalY = rowY + 8;
    const totalBoxW = 180;
    const totalBoxX = ML + CW - totalBoxW;
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
        formatMoney(payload.request.total, payload.business.currency),
        totalBoxX + 10,
        totalY + 8,
        { width: totalBoxW - 16, align: "right" }
      );

    // ── DISCLAIMER BOX ──────────────────────────────────────────────────────
    const disclaimerY = totalY + 44;
    doc.rect(ML, disclaimerY, CW, 24).stroke(BORDER);
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica-Bold")
      .text(
        "ORDEN DE COMPRA — Documento interno, no válido como comprobante fiscal.",
        ML,
        disclaimerY + 8,
        { width: CW, align: "center" }
      );

    // ── FOOTER ──────────────────────────────────────────────────────────────
    doc
      .fontSize(7.5)
      .fillColor(GRAY)
      .font("Helvetica")
      .text("Orden de compra creada en Velora · Tu negocio AI · velora.app", ML, FOOTER_Y, {
        width: CW,
        align: "center",
      });

    doc.end();
  });
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ requestId: string }> }
) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const session = await auth();
  const resolvedParams = await context.params;
  const requestId = resolvedParams?.requestId;
  if (!requestId) {
    return NextResponse.json({ error: "Falta el identificador de la solicitud." }, { status: 400 });
  }

  const tokenResult = validatePdfAccessToken(req, "purchase-request", requestId);
  if (!session?.user?.id && !tokenResult.valid) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  // SEC-02: Tenant isolation — mirror budget/invoice PDF route pattern.
  // Any path without a valid session or v2 token provides no businessId scope
  // and must be rejected to prevent cross-tenant PDF serving.
  const hasSessionScope = !!session?.user?.id;
  const hasV2TokenScope = tokenResult.valid && tokenResult.version === "v2";

  if (!hasSessionScope && !hasV2TokenScope) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  try {
    const businessScope = hasSessionScope
      ? { business: { userId: session!.user!.id } }
      : { businessId: (tokenResult as { businessId: string }).businessId };

    const row = await prisma.purchaseRequest.findFirst({
      where: {
        id: requestId,
        ...businessScope,
      },
      select: {
        requestNumber: true,
        payloadJson: true,
      },
    });
    if (!row) {
      return NextResponse.json({ error: "No se encontró la solicitud de compra." }, { status: 404 });
    }

    let payload: PurchaseRequestPayload;
    try {
      payload = JSON.parse(row.payloadJson) as PurchaseRequestPayload;
    } catch {
      return NextResponse.json(
        { error: "La solicitud de compra guardada no se pudo leer." },
        { status: 500 }
      );
    }

    const pdfBuffer = await buildPdf(payload);
    const filename = `${row.requestNumber.replace(/[^A-Za-z0-9_-]/g, "") || "solicitud-compra"}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    cloudLog({ severity: "ERROR", component: "System", action: "PURCHASE_REQUEST_PDF_FAILED", a2a_transfer: false, message: "Purchase request PDF generation failed", data: { error: error instanceof Error ? error.message : String(error) } });
    return NextResponse.json(
      { error: "No se pudo generar el PDF de la solicitud de compra." },
      { status: 500 }
    );
  }
}
