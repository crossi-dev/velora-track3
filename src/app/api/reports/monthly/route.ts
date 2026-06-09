import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  checkRateLimitExpensive,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";

export interface MonthlyReportData {
  year: number;
  month: number;
  isMonotributista: boolean;
  totalVentasBrutas: number;
  ivaBruto: number;        // 0 si Monotributista
  totalCobros: number;
  totalEfectivo: number;
  totalTransferencia: number;
  totalGastos: number;
  resultadoBruto: number;
  cantidadVentas: number;
  cantidadMovimientos: number;
}

// GET /api/reports/monthly?year=2026&month=5[&format=excel|json]
export async function GET(req: NextRequest) {
  const rateLimited = checkRateLimitExpensive(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  const url = new URL(req.url);
  const year = Number(url.searchParams.get("year") ?? new Date().getFullYear());
  const month = Number(url.searchParams.get("month") ?? new Date().getMonth() + 1);
  const format = url.searchParams.get("format") ?? "json";

  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 0, 23, 59, 59);

  try {
    const [business, sales, movements] = await Promise.all([
      prisma.business.findUnique({
        where: { id: businessId },
        select: { name: true, ivaCondition: true },
      }),
      prisma.sale.findMany({
        where: { businessId, date: { gte: from, lte: to } },
        select: { totalAmount: true, taxAmount: true },
      }),
      prisma.cashMovement.findMany({
        where: { businessId, date: { gte: from, lte: to } },
        select: { type: true, amount: true },
      }),
    ]);

    const isMonotributista =
      !business?.ivaCondition ||
      business.ivaCondition.toLowerCase().includes("monotribut");

    const totalVentasBrutas = sales.reduce((s, v) => s + Number(v.totalAmount), 0);
    const ivaBruto = isMonotributista
      ? 0
      : sales.reduce((s, v) => s + Number(v.taxAmount), 0);

    const incomeMovements = movements.filter((m) => isIncomeType(m.type));
    const expenseMovements = movements.filter((m) => !isIncomeType(m.type));

    const totalCobros = incomeMovements.reduce((s, m) => s + Number(m.amount), 0);
    const totalGastos = expenseMovements.reduce((s, m) => s + Number(m.amount), 0);

    const totalEfectivo = movements
      .filter((m) => m.type === "sale" || m.type === "income")
      .reduce((s, m) => s + Number(m.amount), 0);
    const totalTransferencia = movements
      .filter((m) => m.type === "qr" || m.type === "transfer")
      .reduce((s, m) => s + Number(m.amount), 0);

    const resultadoBruto = totalCobros - totalGastos;

    const data: MonthlyReportData = {
      year,
      month,
      isMonotributista,
      totalVentasBrutas,
      ivaBruto,
      totalCobros,
      totalEfectivo,
      totalTransferencia,
      totalGastos,
      resultadoBruto,
      cantidadVentas: sales.length,
      cantidadMovimientos: movements.length,
    };

    if (format === "excel") {
      return buildExcel(data, from);
    }
    if (format === "pdf") {
      return buildPdf(data, business?.name ?? "Mi negocio", from);
    }

    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logRouteError("reports/monthly", error);
    return NextResponse.json({ code: "INTERNAL_ERROR", message: "No se pudo generar el resumen." }, { status: 500 });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isIncomeType(type: string): boolean {
  return ["sale", "income", "adjustment", "qr", "transfer"].includes(type);
}

function monthName(month: number): string {
  const NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
    "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  return NAMES[month - 1] ?? String(month);
}

function fmt(n: number): string {
  return n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function buildExcel(data: MonthlyReportData, from: Date): Promise<NextResponse> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Resumen mensual");

  sheet.columns = [
    { header: "Concepto", key: "concepto", width: 36 },
    { header: "Valor", key: "valor", width: 20 },
  ];

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A56DB" } };

  const rows: [string, number | string][] = [
    ["Período", `${monthName(data.month)} ${data.year}`],
    ["Régimen", data.isMonotributista ? "Monotributista" : "Responsable Inscripto"],
    ["—", "—"],
    ["Ventas brutas", data.totalVentasBrutas],
    ["IVA discriminado (estimado)", data.ivaBruto],
    ["—", "—"],
    ["Total cobros (efectivo + QR)", data.totalCobros],
    ["  ↳ Efectivo", data.totalEfectivo],
    ["  ↳ Transferencia / QR", data.totalTransferencia],
    ["—", "—"],
    ["Gastos del mes", data.totalGastos],
    ["Resultado bruto", data.resultadoBruto],
    ["—", "—"],
    ["Cantidad de ventas", data.cantidadVentas],
  ];

  for (const [concepto, valor] of rows) {
    const row = sheet.addRow({ concepto, valor });
    if (concepto === "Resultado bruto") row.font = { bold: true };
    if (typeof valor === "number" && valor < 0) {
      const cell = row.getCell("valor");
      cell.font = { ...(cell.font ?? {}), color: { argb: "FFCC0000" } };
    }
    if (typeof valor === "number") {
      row.getCell("valor").numFmt = "#,##0.00";
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `resumen-${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}.xlsx`;

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function buildPdf(data: MonthlyReportData, bizName: string, from: Date): Promise<NextResponse> {
  const PDFDocument = (await import("pdfkit")).default;
  const chunks: Uint8Array[] = [];

  const doc = new PDFDocument({ margin: 48, size: "A4" });
  doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));

  await new Promise<void>((resolve) => {
    doc.on("end", resolve);

    // Header
    doc.fontSize(20).font("Helvetica-Bold").text("Resumen Mensual Contable", { align: "center" });
    doc.fontSize(13).font("Helvetica").text(bizName, { align: "center" });
    doc.moveDown(0.4);
    doc.fontSize(11).text(`Período: ${monthName(data.month)} ${data.year}`, { align: "center" });
    doc.text(`Régimen: ${data.isMonotributista ? "Monotributista" : "Responsable Inscripto"}`, { align: "center" });
    doc.moveDown(1);

    const line = (label: string, value: number | string, bold = false) => {
      const v = typeof value === "number" ? `$ ${fmt(value)}` : String(value);
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11);
      doc.text(label, { continued: true });
      doc.text(v, { align: "right" });
    };

    doc.moveTo(48, doc.y).lineTo(547, doc.y).stroke();
    doc.moveDown(0.5);

    line("Total ventas brutas", data.totalVentasBrutas);
    if (!data.isMonotributista) line("IVA discriminado (estimado)", data.ivaBruto);
    doc.moveDown(0.5);
    line("Total cobros", data.totalCobros);
    line("  Efectivo", data.totalEfectivo);
    line("  Transferencia / QR", data.totalTransferencia);
    doc.moveDown(0.5);
    line("Gastos del mes", data.totalGastos);
    doc.moveDown(0.3);
    doc.moveTo(48, doc.y).lineTo(547, doc.y).stroke();
    doc.moveDown(0.3);
    line("Resultado bruto", data.resultadoBruto, true);
    doc.moveDown(1);
    line("Cantidad de ventas", data.cantidadVentas);

    doc.moveDown(2);
    doc.fontSize(8).fillColor("gray")
      .text("Este reporte es un input para el contador. No reemplaza documentación fiscal oficial.", { align: "center" });

    doc.end();
  });

  const buffer = Buffer.concat(chunks);
  const filename = `resumen-${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}.pdf`;

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
