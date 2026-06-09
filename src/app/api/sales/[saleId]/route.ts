import { NextRequest, NextResponse } from "next/server";
import {
  checkRateLimit,
  internalError,
  logRouteError,
  notFound,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";

// ── GET /api/sales/[saleId] ───────────────────────────────────────────────
// Returns a sale with its items and customer snapshot.
// Logs a read-event to CriticalWriteEvent for compliance (who viewed which sale).

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ saleId: string }> }
) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  const { saleId } = await params;
  const normalizedId = saleId?.trim();
  if (!normalizedId) return notFound("No se encontró la venta.");

  try {
    const sale = await prisma.sale.findFirst({
      where: { id: normalizedId, businessId },
      select: {
        id: true,
        date: true,
        totalAmount: true,
        taxAmount: true,
        status: true,
        customerId: true,
        saleItems: {
          select: {
            id: true,
            productId: true,
            quantity: true,
            unitPrice: true,
          },
        },
      },
    });

    if (!sale) return notFound("No se encontró la venta.");

    void recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId,
      actorEmployeeId,
      actionType: "sale.read",
      resourceType: "Sale",
      resourceId: normalizedId,
      routeScope: "sales/detail",
      summary: `Venta consultada: ${normalizedId}`,
      payload: { saleId: normalizedId },
      input: { saleId: normalizedId },
      after: { id: sale.id, status: sale.status },
    });

    return NextResponse.json({ sale });
  } catch (error) {
    logRouteError("sales/detail", error);
    return internalError("No se pudo obtener la venta.");
  }
}
