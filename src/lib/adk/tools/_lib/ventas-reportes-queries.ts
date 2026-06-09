import "server-only";
// ventas-reportes-queries.ts — DB query helpers for ventas.consultar_ventas.
// Extracted to keep ventas-reportes-tool.ts under the 300-line limit.

import { prisma } from "@/lib/prisma";

// ── ART timezone helpers ───────────────────────────────────────────────────────
// Argentina Standard Time = UTC-3, no DST. All presets anchor to ART midnight.

const ART_TZ = "America/Argentina/Buenos_Aires";

function artParts(d: Date): { y: number; m: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: ART_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  return {
    y: Number(parts.find((p) => p.type === "year")!.value),
    m: Number(parts.find((p) => p.type === "month")!.value),
    day: Number(parts.find((p) => p.type === "day")!.value),
  };
}

// ART midnight = 03:00 UTC (UTC-3). Month is 1-based.
function artMidnightUTC(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m - 1, day, 3, 0, 0, 0));
}

function artEndOfDayUTC(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m - 1, day + 1, 2, 59, 59, 999));
}

export function artTodayRange(): [Date, Date] {
  const { y, m, day } = artParts(new Date());
  return [artMidnightUTC(y, m, day), artEndOfDayUTC(y, m, day)];
}

export function artWeekRange(): [Date, Date] {
  const { y, m, day } = artParts(new Date());
  const todayStart = artMidnightUTC(y, m, day);
  const dow = (todayStart.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const weekStart = new Date(todayStart);
  weekStart.setUTCDate(weekStart.getUTCDate() - dow);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  weekEnd.setUTCMilliseconds(-1);
  return [weekStart, weekEnd];
}

export function artMonthRange(): [Date, Date] {
  const { y, m } = artParts(new Date());
  const monthStart = artMidnightUTC(y, m, 1);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const nextMonthStart = artMidnightUTC(nextY, nextM, 1);
  return [monthStart, new Date(nextMonthStart.getTime() - 1)];
}

export function resolveDateRange(
  preset: string | undefined,
  from: string | undefined,
  to: string | undefined,
): [Date, Date] | { error: string } {
  if (preset) {
    if (preset === "hoy") return artTodayRange();
    if (preset === "semana") return artWeekRange();
    if (preset === "mes") return artMonthRange();
    return { error: `Preset inválido: "${preset}". Usar: hoy | semana | mes.` };
  }
  if (from && to) {
    const fParts = from.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const tParts = to.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!fParts || !tParts) return { error: "Formato de fecha inválido. Usar YYYY-MM-DD." };
    const f = artMidnightUTC(Number(fParts[1]), Number(fParts[2]), Number(fParts[3]));
    const t = artEndOfDayUTC(Number(tParts[1]), Number(tParts[2]), Number(tParts[3]));
    if (f > t) return { error: "La fecha 'from' debe ser anterior o igual a 'to'." };
    return [f, t];
  }
  return { error: "Especificá un preset (hoy|semana|mes) o el par from+to (YYYY-MM-DD)." };
}

export function fmtCurrency(n: number, currency = "ARS"): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

// ── Query functions ────────────────────────────────────────────────────────────

export async function queryVentasPeriodo(businessId: string, dateFrom: Date, dateTo: Date) {
  return prisma.sale.aggregate({
    where: { businessId, date: { gte: dateFrom, lte: dateTo } },
    _sum: { totalAmount: true },
    _count: { id: true },
  });
}

export async function queryMargen(businessId: string, dateFrom: Date, dateTo: Date) {
  return prisma.saleItem.findMany({
    where: { sale: { businessId, date: { gte: dateFrom, lte: dateTo } } },
    select: { quantity: true, unitPrice: true, unitCost: true },
  });
}

export async function queryRankingProductos(
  businessId: string,
  dateFrom: Date,
  dateTo: Date,
  limit: number,
) {
  const grouped = await prisma.saleItem.groupBy({
    by: ["productId"],
    where: { sale: { businessId, date: { gte: dateFrom, lte: dateTo } } },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: limit,
  });

  const productIds = grouped
    .map((g) => g.productId)
    .filter((id): id is string => id !== null);

  const products = await prisma.product.findMany({
    where: { businessId, id: { in: productIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(products.map((p) => [p.id, p.name]));

  return grouped.map((g, idx) => ({
    rank: idx + 1,
    product: g.productId ? (nameById.get(g.productId) ?? "(producto eliminado)") : "(desconocido)",
    unitsSold: g._sum.quantity ?? 0,
  }));
}

export async function queryPorEmpleado(businessId: string, dateFrom: Date, dateTo: Date) {
  const grouped = await prisma.sale.groupBy({
    by: ["employeeId"],
    where: { businessId, date: { gte: dateFrom, lte: dateTo } },
    _sum: { totalAmount: true },
    _count: { id: true },
    orderBy: { _sum: { totalAmount: "desc" } },
  });

  const employeeIds = grouped
    .map((s) => s.employeeId)
    .filter((id): id is string => id !== null);

  const employees = await prisma.employee.findMany({
    where: { businessId, id: { in: employeeIds } },
    select: { id: true, name: true },
  });
  const empNameById = new Map(employees.map((e) => [e.id, e.name]));

  return grouped.map((row) => ({
    employee: row.employeeId
      ? (empNameById.get(row.employeeId) ?? "Empleado eliminado")
      : "Owner",
    saleCount: row._count.id,
    totalRevenue: Number(row._sum.totalAmount ?? 0),
  }));
}

export async function queryHistorialCliente(
  businessId: string,
  rawName: string,
  limit: number,
  currency: string,
) {
  const customers = await prisma.customer.findMany({
    where: { businessId, name: { contains: rawName, mode: "insensitive" } },
    select: { id: true, name: true },
    take: 5,
  });

  if (customers.length === 0) return { kind: "not_found" as const, name: rawName };
  if (customers.length > 1) {
    return { kind: "ambiguous" as const, names: customers.map((c) => c.name) };
  }

  const customer = customers[0];

  // MEDIUM-1 fix: aggregate ALL sales (no take) for the real lifetime total.
  const lifetimeAgg = await prisma.sale.aggregate({
    where: { businessId, customerId: customer.id },
    _sum: { totalAmount: true },
    _count: { id: true },
  });

  // Separate query: only the last `limit` orders for the detail list.
  const recentSales = await prisma.sale.findMany({
    where: { businessId, customerId: customer.id },
    orderBy: { date: "desc" },
    take: limit,
    select: {
      date: true,
      totalAmount: true,
      paymentMethod: true,
      saleItems: {
        select: {
          quantity: true,
          unitPrice: true,
          product: { select: { name: true } },
        },
      },
    },
  });

  const lifetimeTotalSpent = Number(lifetimeAgg._sum.totalAmount ?? 0);
  const lifetimeOrderCount = lifetimeAgg._count.id;

  const recentOrders = recentSales.map((s) => ({
    date: s.date.toLocaleDateString("es-AR", { timeZone: ART_TZ }),
    total: fmtCurrency(Number(s.totalAmount), currency),
    paymentMethod: s.paymentMethod ?? "efectivo",
    items: s.saleItems.map((i) => ({
      product: i.product?.name ?? "(producto eliminado)",
      qty: i.quantity,
      unitPrice: fmtCurrency(Number(i.unitPrice), currency),
    })),
  }));

  return {
    kind: "ok" as const,
    customer: customer.name,
    // MEDIUM-1: lifetime totals come from the full aggregate, not the limited list.
    lifetimeOrderCount,
    lifetimeTotalSpent: fmtCurrency(lifetimeTotalSpent, currency),
    // MEDIUM-2: scope note so the LLM never misleads the owner about the period.
    recentOrdersScope: `últimas ${recentSales.length} compras (sin filtro de fecha)`,
    recentOrders,
  };
}
