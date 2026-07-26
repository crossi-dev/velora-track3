import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import {
  checkRateLimitExpensive,
  logRouteError,
  unauthorized,
  badRequest,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { runWithTraceContext, cloudLog } from "@/lib/cloud-logger";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const QUERY_TAKE_CAP = 10_000;

// GET /api/reports/sales?year=2026&month=5
// GET /api/reports/sales?from=2026-05-01&to=2026-05-31
async function handleGet(req: NextRequest): Promise<NextResponse> {
  const rateLimited = checkRateLimitExpensive(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  const url = new URL(req.url);
  const rangeResult = resolveDateRange(url);
  if (!rangeResult.ok) return badRequest(rangeResult.error);
  const { from, to } = rangeResult;

  try {
    const sales = await prisma.sale.findMany({
      where: { businessId, date: { gte: from, lte: to } },
      orderBy: { date: "asc" },
      take: QUERY_TAKE_CAP,
      select: {
        id: true,
        date: true,
        totalAmount: true,
        customer: { select: { name: true, taxId: true } },
        saleItems: {
          select: {
            quantity: true,
            unitPrice: true,
            product: { select: { name: true } },
          },
        },
        cashMovements: { select: { type: true }, take: 1 },
      },
    });

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "export.sales",
      a2a_transfer: false,
      message: `Sales report exported: ${sales.length} rows`,
      businessId,
      data: { rowCount: sales.length, from: from.toISOString(), to: to.toISOString() },
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Ventas");

    sheet.columns = [
      { header: "Fecha", key: "fecha", width: 14 },
      { header: "Hora", key: "hora", width: 10 },
      { header: "Cliente", key: "cliente", width: 24 },
      { header: "CUIT", key: "cuit", width: 18 },
      { header: "Producto", key: "producto", width: 30 },
      { header: "Cantidad", key: "cantidad", width: 10 },
      { header: "Precio unit.", key: "precio_unit", width: 14 },
      { header: "Subtotal", key: "subtotal", width: 14 },
      { header: "Total venta", key: "total", width: 14 },
      { header: "Método de pago", key: "metodo_pago", width: 18 },
      { header: "Empleado", key: "empleado", width: 20 },
    ];

    styleHeader(sheet);

    for (const sale of sales) {
      const fecha = sale.date.toLocaleDateString("es-AR");
      const hora = sale.date.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      const cliente = sale.customer?.name ?? "—";
      const cuit = sale.customer?.taxId ?? "—";
      const metodo = sale.cashMovements[0]?.type ?? "efectivo";
      // Employee concept removed (0 rows in production, Stage 1 cleanup) —
      // every sale is attributed to the owner now.
      const empleado = "Owner";
      const total = Number(sale.totalAmount);

      if (sale.saleItems.length === 0) {
        sheet.addRow({ fecha, hora, cliente, cuit, producto: "—", cantidad: 0,
          precio_unit: 0, subtotal: 0, total, metodo_pago: metodo, empleado });
        continue;
      }

      sale.saleItems.forEach((item, idx) => {
        const subtotal = item.quantity * Number(item.unitPrice);
        sheet.addRow({
          fecha: idx === 0 ? fecha : "",
          hora: idx === 0 ? hora : "",
          cliente: idx === 0 ? cliente : "",
          cuit: idx === 0 ? cuit : "",
          producto: item.product?.name ?? "Producto eliminado",
          cantidad: item.quantity,
          precio_unit: Number(item.unitPrice),
          subtotal,
          total: idx === 0 ? total : "",
          metodo_pago: idx === 0 ? metodo : "",
          empleado: idx === 0 ? empleado : "",
        });
      });
    }

    applyNumberFormat(sheet, ["precio_unit", "subtotal", "total"]);

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `ventas-${formatMonth(from)}.xlsx`;

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logRouteError("reports/sales", error);
    return NextResponse.json({ code: "INTERNAL_ERROR", message: "No se pudo generar el reporte." }, { status: 500 });
  }
}

export function GET(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handleGet(req));
}

// ── helpers ──────────────────────────────────────────────────────────────────

type DateRangeResult =
  | { ok: true; from: Date; to: Date }
  | { ok: false; error: string };

function resolveDateRange(url: URL): DateRangeResult {
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  if (fromParam !== null || toParam !== null) {
    if (!fromParam || !toParam) {
      return { ok: false, error: "Se requieren ambos parámetros: from y to." };
    }
    if (!DATE_RE.test(fromParam) || !DATE_RE.test(toParam)) {
      return { ok: false, error: "Los parámetros from y to deben tener el formato YYYY-MM-DD." };
    }
    const from = new Date(fromParam + "T00:00:00");
    const to = new Date(toParam + "T23:59:59");
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return { ok: false, error: "Fecha inválida en from o to." };
    }
    if (from > to) {
      return { ok: false, error: "El parámetro from debe ser anterior o igual a to." };
    }
    const diffDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (diffDays > MAX_RANGE_DAYS) {
      return { ok: false, error: `El rango máximo permitido es ${MAX_RANGE_DAYS} días.` };
    }
    return { ok: true, from, to };
  }

  const year = Number(url.searchParams.get("year") ?? new Date().getFullYear());
  const month = Number(url.searchParams.get("month") ?? new Date().getMonth() + 1);
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 0, 23, 59, 59);
  return { ok: true, from, to };
}

function formatMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function styleHeader(sheet: ExcelJS.Worksheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A56DB" } };
  header.alignment = { vertical: "middle" };
}

function applyNumberFormat(sheet: ExcelJS.Worksheet, keys: string[]) {
  sheet.eachRow((row, i) => {
    if (i === 1) return;
    for (const key of keys) {
      const col = sheet.columns.find((c) => c.key === key);
      if (!col || col.number == null) continue;
      const cell = row.getCell(col.number);
      if (typeof cell.value === "number") {
        cell.numFmt = "#,##0.00";
      }
    }
  });
}
