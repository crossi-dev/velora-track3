import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  checkRateLimitExpensive,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { runWithTraceContext, cloudLog } from "@/lib/cloud-logger";

// ── GET /api/admin/audit-log/export ──────────────────────────────────────
// Owner-only CSV export of the unified audit trail (CriticalWriteEvent) for
// compliance requests. Formerly read from AuditLog; merged 2026-05-16.
// Query params:
//   from  — ISO date string, inclusive (defaults to 30 days ago)
//   to    — ISO date string, inclusive (defaults to now)
//   limit — max rows (default 1000, max 5000)

const MAX_ROWS = 5000;
const DEFAULT_DAYS = 30;
const CSV_HEADERS = [
  "id",
  "createdAt",
  "businessId",
  "actorUserId",
  "actorEmployeeId",
  "actionType",
  "resourceType",
  "resourceId",
  "routeScope",
];

function escapeCsvField(value: string | null | undefined): string {
  const s = value ?? "";
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsv(row: Record<string, string | null | undefined>): string {
  return CSV_HEADERS.map((h) => escapeCsvField(row[h])).join(",");
}

async function handleGet(req: NextRequest): Promise<NextResponse> {
  // Expensive: large Postgres scan, CSV streaming — strict limit to prevent DoS.
  const rateLimited = checkRateLimitExpensive(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  const sp = req.nextUrl.searchParams;

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);

  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  const limitRaw = sp.get("limit");

  const from = fromRaw ? new Date(fromRaw) : defaultFrom;
  const to = toRaw ? new Date(toRaw) : now;
  const limit = Math.min(limitRaw ? parseInt(limitRaw, 10) || 1000 : 1000, MAX_ROWS);

  if (isNaN(from.getTime())) return badRequest("Parámetro 'from' inválido.");
  if (isNaN(to.getTime())) return badRequest("Parámetro 'to' inválido.");
  if (from > to) return badRequest("'from' debe ser anterior a 'to'.");

  try {
    const rows = await prisma.criticalWriteEvent.findMany({
      where: {
        businessId,
        createdAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        createdAt: true,
        businessId: true,
        actorUserId: true,
        actorEmployeeId: true,
        actionType: true,
        resourceType: true,
        resourceId: true,
        routeScope: true,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "export.audit_log",
      a2a_transfer: false,
      message: `Audit log exported: ${rows.length} rows`,
      businessId,
      data: { rowCount: rows.length, from: from.toISOString(), to: to.toISOString(), limit },
    });

    const lines: string[] = [CSV_HEADERS.join(",")];
    for (const row of rows) {
      lines.push(rowToCsv({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        businessId: row.businessId,
        actorUserId: row.actorUserId,
        actorEmployeeId: row.actorEmployeeId,
        actionType: row.actionType,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        routeScope: row.routeScope,
      }));
    }

    const csv = lines.join("\n");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-log-${businessId}-${from.toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    logRouteError("admin/audit-log/export", error);
    return internalError("No se pudo exportar el registro de auditoría.");
  }
}

export function GET(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handleGet(req));
}
