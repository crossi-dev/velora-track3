import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog, reportError } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { checkRateLimit, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
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
import { buildBudgetPdf, type BudgetPdfData } from "@/app/api/budgets/[budgetId]/pdf/build-budget-pdf";
import { uploadPdfToGcs, getSignedUrlForGcsKey, buildPdfR2Key } from "@/lib/r2";

const MUTATION_ACTIONS = {
  POST: "budget.send-whatsapp",
} as const satisfies RouteMutationDeclaration;
const BUDGET_SEND_WHATSAPP_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ budgetId: string }> }
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
    const { budgetId } = await params;
    const { phone } = await req.json().catch(() => ({ phone: null })) as { phone?: string | null };

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true, name: true, currency: true, whatsappPhone: true,
        cuit: true, address: true, ivaCondition: true, phone: true,
      },
    });
    if (!business) {
      return NextResponse.json({ code: "BUSINESS_NOT_FOUND", message: "Business not found." }, { status: 404 });
    }

    const budget = await prisma.budget.findFirst({
      where: { id: budgetId, businessId },
      include: { items: true, customer: { select: { phone: true } } },
    });
    if (!budget) {
      return NextResponse.json({ code: "BUDGET_NOT_FOUND", message: "Budget not found." }, { status: 404 });
    }

    const provided = typeof phone === "string" ? phone.trim() : "";
    const resolvedPhone = provided || budget.customer?.phone?.trim() || "";
    if (!resolvedPhone) {
      const hint = budget.customerId
        ? "El cliente no tiene teléfono registrado. Agregá el número en su perfil."
        : "Falta el número de teléfono.";
      return NextResponse.json({ code: "MISSING_PHONE", message: hint }, { status: 400 });
    }
    const recipientPhone = resolvedPhone;

    const idempotency = await beginIdempotentMutation({
      client: prisma,
      businessId,
      actionType: BUDGET_SEND_WHATSAPP_ACTION.actionType,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: { budgetId, phone: recipientPhone },
    });

    if (idempotency.kind !== "execute") {
      return idempotency.response;
    }

    idempotencyRecordId = idempotency.recordId;

    const pdfLink = buildPdfAccessUrl({ req, resource: "budget", id: budget.id, businessId: business.id });
    if (pdfLink === null) {
      await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
      return NextResponse.json(
        { code: "PDF_LINK_UNAVAILABLE", message: "Configurá WHATSAPP_PDF_TOKEN_SECRET para enviar presupuestos por WhatsApp." },
        { status: 400 }
      );
    }
    const messagePayload = appendPdfToWhatsAppMessage([
      `¡Hola! Te enviamos el presupuesto solicitado. Atte: ${business.name}`,
    ].filter(Boolean).join("\n"), pdfLink);

    // Generate PDF in-memory and upload to R2 for signed URL attachment
    let r2MediaUrl: string | undefined;
    try {
      const pdfData: BudgetPdfData = {
        businessName: business.name,
        businessCuit: business.cuit ?? null,
        businessAddress: business.address ?? null,
        businessIvaCondition: business.ivaCondition ?? null,
        businessPhone: business.phone ?? null,
        businessWhatsapp: business.whatsappPhone ?? null,
        currency: budget.currency,
        budgetNumber: budget.budgetNumber,
        customerName: budget.customerName ?? null,
        customerTaxId: null,
        customerEmail: null,
        customerPhone: null,
        createdAt: budget.createdAt,
        items: budget.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          subtotal: Number(item.unitPrice) * item.quantity,
        })),
        shippingCost: null,
        paymentLinkUrl: null,
        total: Number(budget.totalAmount),
      };
      const pdfBuffer = await buildBudgetPdf(pdfData);
      const r2Key = buildPdfR2Key("budget", businessId, budgetId, budget.budgetNumber ?? undefined);
      const gcsKey = await uploadPdfToGcs(r2Key, pdfBuffer);
      const signedUrl = gcsKey ? await getSignedUrlForGcsKey(gcsKey) : null;
      if (signedUrl) {
        r2MediaUrl = signedUrl;
      }
    } catch (r2Err) {
      cloudLog({ severity: "WARNING", component: "System", action: "BUDGET_R2_UPLOAD_FAILED", a2a_transfer: false, message: "Budget PDF R2 upload failed; sending without attachment", data: { budgetId, error: r2Err instanceof Error ? r2Err.message : String(r2Err) } });
      reportError(r2Err, { scope: "budgets.whatsapp.r2-upload" });
    }

    let whatsappSendStatus: "success" | "failed" = "success";
    let sendError: unknown = null;
    try {
      await sendWhatsAppMessage(recipientPhone, messagePayload.text, r2MediaUrl);
    } catch (err) {
      whatsappSendStatus = "failed";
      sendError = err;
      reportError(err, { scope: "budgets.whatsapp.send" });
    }

    await recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId,
      routeScope: BUDGET_SEND_WHATSAPP_ACTION.routeScope,
      actionType: BUDGET_SEND_WHATSAPP_ACTION.actionType,
      resourceType: BUDGET_SEND_WHATSAPP_ACTION.resourceType,
      resourceId: budget.id,
      summary: whatsappSendStatus === "success"
        ? `Presupuesto ${budget.budgetNumber} enviado por WhatsApp`
        : `Presupuesto ${budget.budgetNumber} falló envío por WhatsApp`,
      payload: {
        budgetId: budget.id,
        budgetNumber: budget.budgetNumber,
        sentTo: recipientPhone,
        whatsappSendStatus,
      },
    });

    if (sendError) {
      await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
      logRouteError("budgets/send-whatsapp", sendError);
      return NextResponse.json(
        { code: "WHATSAPP_SEND_FAILED", message: "Could not send budget via WhatsApp. Verify the number includes the country code (e.g. +54911...)." },
        { status: 500 }
      );
    }

    const responseBody = {
      ok: true,
      sentTo: recipientPhone,
      budgetNumber: budget.budgetNumber,
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
      cloudLog({ severity: "ERROR", component: "System", action: "BUDGET_DB_UPDATE_FAILED", a2a_transfer: false, message: "Budget DB status update after WhatsApp send failed", data: { budgetId, error: dbErr instanceof Error ? dbErr.message : String(dbErr) } });
      reportError(dbErr, { scope: "budgets.whatsapp.db-after-send" });
      // Release the idempotency record so a retry is possible.
      // WhatsApp was already sent; the client will get a success response regardless.
      try {
        await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
      } catch { /* safe — TTL prune will clean up */ }
    }

    return NextResponse.json(responseBody);
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
    logRouteError("budgets/send-whatsapp", error);
    return NextResponse.json(
      { code: "WHATSAPP_SEND_FAILED", message: "Could not send budget via WhatsApp. Verify the number includes the country code (e.g. +54911...)." },
      { status: 500 }
    );
  }
}
