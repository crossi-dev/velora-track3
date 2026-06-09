import { NextRequest, NextResponse } from "next/server";
import { bypassIfTester, checkRateLimit, internalError, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prismaInvoiceRepository } from "@/infrastructure/persistence/prisma-invoice.repository";

export async function GET(req: NextRequest) {
  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(resolvedCtx));
  if (rateLimited) return rateLimited;
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = resolvedCtx;

  try {
    const invoices = await prismaInvoiceRepository.list(businessId);
    const response = NextResponse.json({ invoices });
    response.headers.set("Cache-Control", "private, max-age=15, stale-while-revalidate=30");
    return response;
  } catch (error) {
    logRouteError("invoices/list", error);
    return internalError("No se pudieron obtener las facturas.");
  }
}
