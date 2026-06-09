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

// GET /api/reports/cash?year=2026&month=5
// GET /api/reports/cash?from=2026-05-01&to=2026-05-31
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
    const movements = await prisma.cashMovement.findMany({
      where: { businessId, date: { gte: from, lte: to } },
      orderBy: { date: "asc" },
      take: QUERY_TAKE_CAP,
      select: {
        id: true,
        date: true,
        type: true,
        description: true,
        amount: true,
      },
    });

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "export.cash",
      a2a_transfer: false,
      message: `Cash report exported: ${movements.length} rows`,
      businessId,
      data: { rowCount: movements.length, from: from.toISOString(), to: to.toISOString() },
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Caja");

    sheet.columns = [
      { header: "Fecha", key: "fecha", width: 14 },
      { header: "Hora", key: "hora", width: 10 },
      { header: "Tipo", key: "tipo", width: 12 },
      { header: "Categoría", key: "categoria", width: 20 },
      { header: "Descripción", key: "descripcion", width: 36 },
      { header: "Monto", key: "monto", width: 14 },
      { header: "Saldo acumulado", key: "saldo", width: 16 },
    ];

    styleHeader(sheet);

    let saldo = 0;
    for (const m of movements) {
      const amount = Number(m.amount);
      const isIncome = isIncomeType(m.type);
      saldo += isIncome ? amount : -amount;

      sheet.addRow({
        fecha: m.date.toLocaleDateString("es-AR"),
        hora: m.date.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }),
        tipo: isIncome ? "Ingreso" : "Egreso",
        categoria: categoriaLabel(m.type),
        descripcion: m.description,
        monto: isIncome ? amount : -amount,
        saldo: saldo,
      });
    }

    sheet.eachRow((row, i) => {
      if (i === 1) return;
      ["monto", "saldo"].forEach((key) => {
        const col = sheet.columns.find((c) => c.key === key);
        if (!col || col.number == null) return;
        const cell = row.getCell(col.number);
        if (typeof cell.value === "number") {
          cell.numFmt = "#,##0.00";
          if (cell.value < 0) cell.font = { color: { argb: "FFCC0000" } };
        }
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `caja-${formatMonth(from)}.xlsx`;

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logRouteError("reports/cash", error);
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

// PRE-SIGNED types: amount is already stored with the correct sign in the DB
// (createCashMovementInTransaction applies sign at write time).
// For these, the accumulator must use `saldo += amount` (the "income" branch).
// For all other types: amount is stored as the raw magnitude and the sign is
// determined here by whether the type represents an outflow.
//
// "refund"    — negative amount (cash leaving) — pre-signed, include in set.
// "withdrawal"— negative amount (sangría/retiro) — pre-signed, include in set.
//   C4: "withdrawal" was missing from this set. It was falling into the `else`
//   branch: `saldo -= amount = saldo -= (-monto) = saldo + monto` — wrong,
//   a sangría was INCREASING the running balance instead of decreasing it.
const PRE_SIGNED_TYPES = new Set(["sale", "income", "adjustment", "refund", "withdrawal"]);

function isIncomeType(type: string): boolean {
  return PRE_SIGNED_TYPES.has(type);
}

function categoriaLabel(type: string): string {
  const MAP: Record<string, string> = {
    sale: "Venta",
    income: "Ingreso",
    expense: "Gasto",
    purchase: "Compra",
    tax: "Impuesto",
    salary: "Salario",
    adjustment: "Ajuste",
    refund: "Devolución",
    // "withdrawal" = sangría / retiro de efectivo de caja. Added 2026-06-03.
    withdrawal: "Retiro / Sangría",
  };
  return MAP[type] ?? type;
}

function styleHeader(sheet: ExcelJS.Worksheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A56DB" } };
  header.alignment = { vertical: "middle" };
}
