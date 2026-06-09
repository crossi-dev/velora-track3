import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  checkRateLimit,
  conflict,
  internalError,
  logRouteError,
  notFound,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { updateInvoiceStatusBodySchema } from "@/app/api/invoices/invoice-schema";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { updateInvoiceStatusUseCase } from "@/application/use-cases/update-invoice-status.use-case";
import { prismaInvoiceRepository } from "@/infrastructure/persistence/prisma-invoice.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";

const MUTATION_ACTIONS = {
  PATCH: "invoice.update-status",
} as const satisfies RouteMutationDeclaration;
const INVOICE_UPDATE_STATUS_ACTION = getServerActionMeta(MUTATION_ACTIONS.PATCH);

const invoiceStatusUseCase = updateInvoiceStatusUseCase({
  invoice: prismaInvoiceRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

// ── GET /api/invoices/[invoiceId] ─────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> }
) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  const { invoiceId } = await params;
  const normalizedInvoiceId = invoiceId?.trim();
  if (!normalizedInvoiceId) return badRequest("El identificador de la factura es inválido.");

  try {
    const invoice = await prismaInvoiceRepository.findDetail(businessId, normalizedInvoiceId);
    if (!invoice) return notFound("No se encontró la factura.");

    let payload: unknown = null;
    try {
      payload = JSON.parse(invoice.payloadJson);
    } catch {
      // If payloadJson is corrupted, return null — the frontend handles it
    }

    const { payloadJson: _payloadJson, ...rest } = invoice;
    return NextResponse.json({ invoice: { ...rest, payload } });
  } catch (error) {
    logRouteError("invoices/detail", error);
    return internalError("No se pudo obtener la factura.");
  }
}

// ── PATCH /api/invoices/[invoiceId] ───────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> }
) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  const { invoiceId } = await params;
  const normalizedInvoiceId = invoiceId?.trim();
  if (!normalizedInvoiceId) return badRequest("El identificador de la factura es inválido.");

  const parsed = await parseZodBody(req, updateInvoiceStatusBodySchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await invoiceStatusUseCase.execute({
      businessId,
      actorUserId,
      actorEmployeeId,
      invoiceId: normalizedInvoiceId,
      newStatus: parsed.data.status,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: { invoiceId: normalizedInvoiceId, status: parsed.data.status },
      actionMeta: INVOICE_UPDATE_STATUS_ACTION,
    });

    if (result.outcome === "not_found") return notFound("No se encontró la factura.");
    if (result.outcome === "paid_downgrade") return badRequest("No se puede cambiar el estado de una factura cobrada.");
    if (result.outcome === "sent_to_issued") return badRequest("No se puede revertir una factura enviada a emitida.");
    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "updated") return internalError("No se pudo actualizar la factura.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ invoice: result.invoice });
  } catch (error) {
    logRouteError("invoices/status", error);
    return internalError("No se pudo actualizar la factura.");
  }
}
