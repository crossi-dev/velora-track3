import { NextRequest, NextResponse } from "next/server";
import { cloudLog, reportError } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { sendWhatsAppMessage, toUserVisibleWhatsAppErrorMessage } from "@/lib/whatsapp";
import { bypassIfTester, checkRateLimit, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { buildPdfAccessUrl } from "@/app/api/_lib/pdf-access";
import { appendPdfToWhatsAppMessage } from "@/app/api/_lib/whatsapp-pdf-message";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  getIdempotencyKey,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { buildInvoicePdf, type InvoicePdfPayload } from "@/app/api/invoices/[invoiceId]/pdf/build-invoice-pdf";
import { uploadPdfToGcs, getSignedUrlForGcsKey, buildPdfR2Key } from "@/lib/r2";


// Use InvoicePdfPayload as the canonical payload type — it includes all fields
// needed for both WhatsApp summary and PDF generation (ivaCondition, taxRate, etc.)
type InvoicePayload = InvoicePdfPayload;

function normalizeOptionalPhone(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const MUTATION_ACTIONS = {
  POST: "invoice.send-whatsapp",
} as const satisfies RouteMutationDeclaration;
const INVOICE_SEND_WHATSAPP_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

function getDocumentLabel(invoiceNumber: string) {
  return invoiceNumber.trim().toUpperCase().startsWith("FC-") ? "Factura" : "Comprobante";
}

function buildInvoiceWhatsAppSummary(payload: InvoicePayload) {
  const label = getDocumentLabel(payload.sale.invoiceNumber).toLowerCase();
  return `¡Hola! Te enviamos el ${label} solicitado. Atte: ${payload.business.name}`;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ invoiceId: string }> }
) {
  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(resolvedCtx));
  if (rateLimited) return rateLimited;
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = resolvedCtx;

  let idempotencyRecordId: string | null = null;

  try {

    const resolvedParams = await context.params;
    const invoiceId = resolvedParams?.invoiceId;
    const body = await req.json().catch(() => ({ phone: null })) as {
      phone?: string | null;
      payload?: InvoicePayload | null;
      invoiceNumber?: string | null;
    };
    const requestedPhone = normalizeOptionalPhone(body.phone);

    if (!invoiceId) {
      return NextResponse.json({ code: "MISSING_INVOICE_ID", message: "Invoice identifier is required." }, { status: 400 });
    }

    let payload: InvoicePayload | null = body.payload ?? null;
    let invoiceNumberForLookup: string | null = body.invoiceNumber ?? null;
    let rowStatus: string | null = null;
    let rowCustomerId: string | null = null;

    if (payload) {
      // Fast path: caller (sale.create flow) just created this invoice and
      // passed us the payload. We trust the payload but DO NOT do a DB read
      // here — that would re-introduce the read-after-write race against
      // Neon's connection pooler. Authorization is enforced downstream:
      //   - The status update is scoped by `businessId: businessId`, so any
      //     attempt to update an invoice from another business is a no-op.
      //   - The WhatsApp message uses customer data from the caller-supplied
      //     payload, which the caller already controls (no cross-tenant risk).
      //   - Idempotency record is keyed by businessId, preventing replay
      //     across tenants.
      invoiceNumberForLookup = body.invoiceNumber ?? payload.sale.invoiceNumber;
      // No prior status known on the fast path — assume "issued" so we
      // transition to "sent". The updateMany guard preserves "paid" if so.
      rowStatus = "issued";
      rowCustomerId = null;
    } else {
      // Slow path: no payload in body — read the full row from the DB.
      // Single retry covers brief Neon read-after-write lag for callers
      // other than sale.create (e.g. resending an old invoice).
      let row = await prisma.invoice.findFirst({
        where: { id: invoiceId, businessId: businessId },
        select: { invoiceNumber: true, payloadJson: true, status: true, customerId: true },
      });
      if (!row) {
        await new Promise((r) => setTimeout(r, 1500));
        row = await prisma.invoice.findFirst({
          where: { id: invoiceId, businessId: businessId },
          select: { invoiceNumber: true, payloadJson: true, status: true, customerId: true },
        });
      }
      if (!row) {
        return NextResponse.json({ code: "INVOICE_NOT_FOUND", message: "Invoice not found." }, { status: 404 });
      }
      try {
        payload = JSON.parse(row.payloadJson) as InvoicePayload;
      } catch {
        return NextResponse.json({ code: "INVOICE_PARSE_FAILED", message: "Could not read the stored invoice." }, { status: 500 });
      }
      invoiceNumberForLookup = row.invoiceNumber;
      rowStatus = row.status;
      rowCustomerId = row.customerId;
    }

    if (!invoiceNumberForLookup) {
      invoiceNumberForLookup = payload.sale.invoiceNumber;
    }

    const payloadPhone = normalizeOptionalPhone(payload.customer.phone);
    let customerPhone = requestedPhone ?? payloadPhone;

    if (!customerPhone && rowCustomerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: rowCustomerId, businessId: businessId },
        select: { phone: true },
      });
      customerPhone = normalizeOptionalPhone(customer?.phone);
    }

    if (!customerPhone) {
      // El cliente que recibe el comprobante no tiene número cargado.
      // Hoy la UI oculta el botón cuando el cliente no tiene teléfono
      // (canSendInvoiceByWhatsapp), así que este 400 es defense-in-depth
      // para llamadas directas a la API. Mensaje accionable: dice qué
      // falta sin nombrar la implementación interna.
      return NextResponse.json(
        { code: "MISSING_PHONE", message: "The customer does not have a phone number on record." },
        { status: 400 }
      );
    }

    const idempotency = await beginIdempotentMutation({
      client: prisma,
      businessId: businessId,
      actionType: INVOICE_SEND_WHATSAPP_ACTION.actionType,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: { invoiceId, phone: customerPhone },
    });

    if (idempotency.kind !== "execute") {
      return idempotency.response;
    }

    idempotencyRecordId = idempotency.recordId;
    const pdfLink = buildPdfAccessUrl({ req, resource: "invoice", id: invoiceId, businessId: businessId });
    const messagePayload = appendPdfToWhatsAppMessage([
      buildInvoiceWhatsAppSummary(payload),
    ].filter(Boolean).join("\n"), pdfLink);

    // Generate PDF in-memory and upload to R2 for signed URL attachment
    let r2MediaUrl: string | undefined;
    let pdfAttached = false;
    try {
      const pdfBuffer = await buildInvoicePdf(payload);
      const r2Key = buildPdfR2Key("invoice", businessId, invoiceId, invoiceNumberForLookup ?? undefined);
      const gcsKey = await uploadPdfToGcs(r2Key, pdfBuffer);
      const signedUrl = gcsKey ? await getSignedUrlForGcsKey(gcsKey) : null;
      if (signedUrl) {
        r2MediaUrl = signedUrl;
        pdfAttached = true;
      }
    } catch (r2Err) {
      // R2 upload failed — fall back to text-only, do not crash
      cloudLog({ severity: "WARNING", component: "System", action: "INVOICE_R2_UPLOAD_FAILED", a2a_transfer: false, message: "R2 upload failed, falling back to text-only WhatsApp", businessId: businessId, data: { invoiceId, error: r2Err instanceof Error ? r2Err.message : String(r2Err) } });
      reportError(r2Err, { scope: "invoices.whatsapp.r2-upload" });
    }

    let whatsappSendStatus: "success" | "failed" = "success";
    let sendError: unknown = null;
    try {
      await sendWhatsAppMessage(customerPhone, messagePayload.text, r2MediaUrl);
    } catch (err) {
      whatsappSendStatus = "failed";
      sendError = err;
    }

    // Always record the trace regardless of send outcome.
    const docLabel = getDocumentLabel(payload.sale.invoiceNumber);
    await recordCriticalWriteEvent({
      client: prisma,
      businessId: businessId,
      actorUserId,
      routeScope: INVOICE_SEND_WHATSAPP_ACTION.routeScope,
      actionType: INVOICE_SEND_WHATSAPP_ACTION.actionType,
      resourceType: INVOICE_SEND_WHATSAPP_ACTION.resourceType,
      resourceId: invoiceId,
      summary: whatsappSendStatus === "success"
        ? `${docLabel} ${payload.sale.invoiceNumber} enviada por WhatsApp`
        : `${docLabel} ${payload.sale.invoiceNumber} falló envío por WhatsApp`,
      payload: {
        invoiceId,
        invoiceNumber: payload.sale.invoiceNumber,
        sentTo: customerPhone,
        whatsappSendStatus,
      },
    });

    if (sendError) {
      await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
      logRouteError("invoices/send-whatsapp", sendError);
      const errorMessage = toUserVisibleWhatsAppErrorMessage(
        sendError,
        `No se pudo enviar el ${docLabel.toLowerCase()} por WhatsApp. Verificá el número con prefijo de país (ej: +54911...).`
      );
      return NextResponse.json(
        { code: "WHATSAPP_SEND_FAILED", message: errorMessage },
        { status: 500 }
      );
    }

    // On the fast path (caller passed payload), we don't know the prior
    // status — assume "issued" so we transition to "sent". On the slow
    // path, we have rowStatus and preserve "paid" if already paid.
    const priorStatus = rowStatus ?? "issued";
    const nextStatus = priorStatus === "paid" ? "paid" : "sent";
    const wasAlreadySentOrPaid = priorStatus === "sent" || priorStatus === "paid";
    const responseBody = {
      ok: true,
      sentTo: customerPhone,
      invoiceNumber: payload.sale.invoiceNumber,
      status: nextStatus,
      pdfAttached,
      ...(wasAlreadySentOrPaid ? { resent: true } : {}),
    };

    // WhatsApp send succeeded — commit DB updates best-effort.
    // If the DB transaction fails, the user still gets a success response
    // because the message was already delivered. The DB update will be
    // retried on the next data reload.
    try {
      await prisma.$transaction(async (tx) => {
        // Use updateMany scoped by businessId so we (a) never overwrite
        // an invoice belonging to a different business, and (b) preserve
        // "paid" status if the invoice was already paid. This is also
        // idempotent — re-sending an already-sent invoice is a no-op.
        await tx.invoice.updateMany({
          where: { id: invoiceId, businessId: businessId, status: { not: "paid" } },
          data: { status: nextStatus },
        });

        await completeIdempotentMutation({
          client: tx,
          recordId: idempotencyRecordId!,
          responseStatus: 200,
          responseBody,
        });
      });
    } catch (dbError) {
      // Log DB failure but do NOT return an error to the user — the
      // WhatsApp message was already sent successfully.
      logRouteError("invoices/send-whatsapp/db-update", dbError, { invoiceId });
      reportError(dbError, { scope: "invoices.whatsapp.db-after-send", invoiceId });
      try {
        await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
      } catch { /* safe */ }
    }

    return NextResponse.json(responseBody);
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
    logRouteError("invoices/send-whatsapp", error);
    const errorMessage = toUserVisibleWhatsAppErrorMessage(
      error,
      "No se pudo enviar la factura por WhatsApp. Verificá el número con prefijo de país (ej: +54911...)."
    );
    return NextResponse.json(
      { code: "WHATSAPP_SEND_FAILED", message: errorMessage },
      { status: 500 }
    );
  }
}
