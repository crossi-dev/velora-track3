import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, internalError, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";

// Vista del dueño sobre la actividad del equipo. Owner-only — los empleados
// no pueden ver actividad agregada del resto. La cookie del empleado va por
// resolveActor pero acá pedimos OAuth directo (más estricto).
//
// Hoy aggregamos en memoria (parse payloadJson por fila para sumar totals).
// Hasta unos pocos miles de eventos por día por business es trivial.
// Cuando un business pase ese umbral movemos a una materialized view.

type Period = "today" | "7d" | "30d";

interface EmployeeActivity {
  id: string;
  name: string;
  role: string;
  active: boolean;
  salesCount: number;
  salesTotal: number;
  stockMovements: number;
  cashMovements: number;
  lastActivityAt: string | null;
}

interface ActivityResponse {
  period: Period;
  rangeStart: string;
  employees: EmployeeActivity[];
}

const SALES_ACTION = "sale.create";
const STOCK_ACTION = "stock-load.create";
const CASH_ACTION = "cash-movement.create";

function parsePeriod(value: string | null): Period {
  if (value === "7d" || value === "30d") return value;
  return "today";
}

function computeRangeStart(period: Period): Date {
  const now = new Date();
  if (period === "today") {
    // Local server time. Para MVP suficiente — el dashboard del owner
    // suele leerse en su horario operativo, no necesita timezone awareness.
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  const days = period === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function readSaleTotal(payloadJson: string): number {
  try {
    const parsed = JSON.parse(payloadJson) as { totalAmount?: unknown };
    const t = parsed.totalAmount;
    if (typeof t === "number" && Number.isFinite(t)) return t;
    if (typeof t === "string") {
      const n = Number(t);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  const url = new URL(req.url);
  const period = parsePeriod(url.searchParams.get("period"));
  const rangeStart = computeRangeStart(period);

  try {
    const [employees, events] = await Promise.all([
      prisma.employee.findMany({
        where: { businessId },
        select: {
          id: true,
          name: true,
          role: true,
          active: true,
          lastLoginAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.criticalWriteEvent.findMany({
        where: {
          businessId,
          actorEmployeeId: { not: null },
          createdAt: { gte: rangeStart },
          actionType: { in: [SALES_ACTION, STOCK_ACTION, CASH_ACTION] },
        },
        select: {
          actorEmployeeId: true,
          actionType: true,
          payloadJson: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        // Cap at 2000 events per period — a business doing 100 ops/day × 30 days
        // stays under this. Without a cap a high-volume business could DoS this
        // endpoint by requesting the "30d" period with thousands of events.
        take: 2_000,
      }),
    ]);

    const aggregateByEmployee = new Map<string, {
      salesCount: number;
      salesTotal: number;
      stockMovements: number;
      cashMovements: number;
      lastActivityAt: Date | null;
    }>();

    for (const event of events) {
      const empId = event.actorEmployeeId;
      if (!empId) continue;
      const slot = aggregateByEmployee.get(empId) ?? {
        salesCount: 0,
        salesTotal: 0,
        stockMovements: 0,
        cashMovements: 0,
        lastActivityAt: null as Date | null,
      };
      if (event.actionType === SALES_ACTION) {
        slot.salesCount += 1;
        slot.salesTotal += readSaleTotal(event.payloadJson);
      } else if (event.actionType === STOCK_ACTION) {
        slot.stockMovements += 1;
      } else if (event.actionType === CASH_ACTION) {
        slot.cashMovements += 1;
      }
      if (!slot.lastActivityAt || event.createdAt > slot.lastActivityAt) {
        slot.lastActivityAt = event.createdAt;
      }
      aggregateByEmployee.set(empId, slot);
    }

    const rows: EmployeeActivity[] = employees.map((emp) => {
      const agg = aggregateByEmployee.get(emp.id);
      const lastFromActivity = agg?.lastActivityAt ?? null;
      const lastFromLogin = emp.lastLoginAt ?? null;
      const last = lastFromActivity && lastFromLogin
        ? (lastFromActivity > lastFromLogin ? lastFromActivity : lastFromLogin)
        : (lastFromActivity ?? lastFromLogin);
      return {
        id: emp.id,
        name: emp.name,
        role: emp.role,
        active: emp.active,
        salesCount: agg?.salesCount ?? 0,
        salesTotal: agg ? Math.round(agg.salesTotal * 100) / 100 : 0,
        stockMovements: agg?.stockMovements ?? 0,
        cashMovements: agg?.cashMovements ?? 0,
        lastActivityAt: last ? last.toISOString() : null,
      };
    });

    const response: ActivityResponse = {
      period,
      rangeStart: rangeStart.toISOString(),
      employees: rows,
    };
    return NextResponse.json(response);
  } catch (error) {
    logRouteError("business.employees.activity.GET", error);
    return internalError("No se pudo cargar la actividad del equipo.");
  }
}
