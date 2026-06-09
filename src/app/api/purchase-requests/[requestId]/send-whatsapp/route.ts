import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog, reportError } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { checkRateLimit, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  getIdempotencyKey,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";

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
const MUTATION_ACTIONS = {
  POST: "purchase-request.send-whatsapp",
} as const satisfies RouteMutationDeclaration;
const PURCHASE_REQUEST_SEND_WHATSAPP_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

// Use canonical formatter with ISO-prefix style for purchase-request WhatsApp text.
import { formatMoney as canonicalFormatMoney } from "@/lib/format/money";
function formatMoney(value: number, currency: string): string {
  return canonicalFormatMoney(value, currency, { style: "iso-prefix", decimals: 2 });
}

function buildItemsSummary(items: PurchaseRequestPayload["request"]["items"]) {
  if (items.length === 0) return "Sin ítems.";

  const head = items
    .slice(0, 3)
    .map((item) => `${item.itemName} x${item.quantity}`)
    .join(", ");
  const remaining = items.length - 3;

  if (remaining > 0) {
    return `${head} +${remaining} ${remaining === 1 ? "ítem más" : "ítems más"}.`;
  }

  return `${head}.`;
}

function buildPurchaseRequestWhatsAppSummary(payload: PurchaseRequestPayload) {
  const date = new Date(payload.request.date).toLocaleDateString("es-AR");
  const total = formatMoney(payload.request.total, payload.business.currency);
  const itemsSummary = buildItemsSummary(payload.request.items);

  return [
    `Solicitud de compra ${payload.request.requestNumber}`,
    `Negocio: ${payload.business.name}`,
    `Proveedor: ${payload.supplier.name}`,
    `Fecha: ${date}`,
    `Total: ${total}`,
    `Ítems: ${itemsSummary}`,
  ].join("\n");
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ requestId: string }> }
) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = resolvedCtx;

  let idempotencyRecordId: string | null = null;

  try {
    const resolvedParams = await context.params;
    const requestId = resolvedParams?.requestId;

    if (!requestId) {
      return NextResponse.json({ code: "MISSING_REQUEST_ID", message: "Purchase request identifier is required." }, { status: 400 });
    }

    const row = await prisma.purchaseRequest.findFirst({
      where: {
        id: requestId,
        businessId,
      },
      select: {
        requestNumber: true,
        payloadJson: true,
      },
    });
    if (!row) {
      return NextResponse.json({ code: "REQUEST_NOT_FOUND", message: "Purchase request not found." }, { status: 404 });
    }

    let payload: PurchaseRequestPayload;
    try {
      payload = JSON.parse(row.payloadJson) as PurchaseRequestPayload;
    } catch {
      return NextResponse.json(
        { code: "REQUEST_PARSE_FAILED", message: "Could not read the stored purchase request." },
        { status: 500 }
      );
    }

    const supplierPhone = payload.supplier.phone?.trim();
    if (!supplierPhone) {
      return NextResponse.json(
        { code: "MISSING_SUPPLIER_PHONE", message: "The purchase request does not have a supplier phone number for WhatsApp." },
        { status: 400 }
      );
    }

    const idempotency = await beginIdempotentMutation({
      client: prisma,
      businessId,
      actionType: PURCHASE_REQUEST_SEND_WHATSAPP_ACTION.actionType,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: { requestId },
    });

    if (idempotency.kind !== "execute") {
      return idempotency.response;
    }

    idempotencyRecordId = idempotency.recordId;
    const messageText = buildPurchaseRequestWhatsAppSummary(payload);

    let whatsappSendStatus: "success" | "failed" = "success";
    let sendError: unknown = null;
    try {
      await sendWhatsAppMessage(supplierPhone, messageText);
    } catch (err) {
      whatsappSendStatus = "failed";
      sendError = err;
    }

    await recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId,
      routeScope: PURCHASE_REQUEST_SEND_WHATSAPP_ACTION.routeScope,
      actionType: PURCHASE_REQUEST_SEND_WHATSAPP_ACTION.actionType,
      resourceType: PURCHASE_REQUEST_SEND_WHATSAPP_ACTION.resourceType,
      resourceId: requestId,
      summary: whatsappSendStatus === "success"
        ? `Solicitud ${payload.request.requestNumber} enviada por WhatsApp`
        : `Solicitud ${payload.request.requestNumber} falló envío por WhatsApp`,
      payload: {
        requestId,
        requestNumber: payload.request.requestNumber,
        sentTo: supplierPhone,
        whatsappSendStatus,
      },
    });

    if (sendError) {
      await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
      logRouteError("purchase-requests/send-whatsapp", sendError);
      return NextResponse.json(
        { code: "WHATSAPP_SEND_FAILED", message: "Could not send purchase request via WhatsApp. Verify the number includes the country code (e.g. +54911...)." },
        { status: 500 }
      );
    }

    const responseBody = {
      ok: true,
      sentTo: supplierPhone,
      requestNumber: payload.request.requestNumber,
    };

    try {
      await prisma.$transaction(async (tx) => {
        await completeIdempotentMutation({
          client: tx,
          recordId: idempotencyRecordId!,
          responseStatus: 200,
          responseBody,
        });
      });
    } catch (dbErr) {
      cloudLog({ severity: "ERROR", component: "System", action: "PR_SEND_DB_UPDATE_FAILED", a2a_transfer: false, message: "DB update after WhatsApp send failed", businessId, data: { error: dbErr instanceof Error ? dbErr.message : String(dbErr) } });
      reportError(dbErr, { scope: "purchase-requests.whatsapp.db-update" });
      // Release the idempotency record so a retry is possible.
      try {
        await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
      } catch { /* safe — TTL prune will clean up */ }
    }

    return NextResponse.json(responseBody);
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
    logRouteError("purchase-requests/send-whatsapp", error);
    return NextResponse.json(
      { code: "WHATSAPP_SEND_FAILED", message: "Could not send purchase request via WhatsApp. Verify the number includes the country code (e.g. +54911...)." },
      { status: 500 }
    );
  }
}
