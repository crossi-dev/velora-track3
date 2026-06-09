import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { cloudLog } from "@/lib/cloud-logger";
import { validatePdfAccessToken } from "@/app/api/_lib/pdf-access";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";
import { buildInvoicePdf, type InvoicePdfPayload } from "./build-invoice-pdf";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ invoiceId: string }> }
) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const resolvedParams = await context.params;
  const invoiceId = resolvedParams?.invoiceId;

  if (!invoiceId) {
    return NextResponse.json({ error: "Falta el identificador de la factura." }, { status: 400 });
  }

  const session = await auth();
  const tokenResult = validatePdfAccessToken(req, "invoice", invoiceId);
  if (!session?.user?.id && !tokenResult.valid) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  // SEC-02: Tenant isolation strategy
  // - Session path: query scoped to business.userId === session.user.id
  // - V2 token path: HMAC binds resource + businessId + expiry; query also scoped to businessId
  // - Any other combination (e.g. v1 token) has no tenant scope → reject to prevent cross-tenant leak.

  const hasSessionScope = !!session?.user?.id;
  const hasV2TokenScope = tokenResult.valid && tokenResult.version === "v2";

  if (!hasSessionScope && !hasV2TokenScope) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  try {
    const businessScope = hasSessionScope
      ? { business: { userId: session!.user!.id } }
      : { businessId: (tokenResult as { businessId: string }).businessId };

    const row = await prisma.invoice.findFirst({
      where: {
        id: invoiceId,
        ...businessScope,
      },
      select: { invoiceNumber: true, payloadJson: true, documentType: true, status: true, fiscalTipo: true, caeCode: true, caeFchVto: true, fiscalQrUrl: true },
    });
    if (!row) {
      return NextResponse.json({ error: "No se encontró la factura." }, { status: 404 });
    }

    let payload: InvoicePdfPayload;
    try {
      payload = JSON.parse(row.payloadJson) as InvoicePdfPayload;
    } catch {
      return NextResponse.json({ error: "La factura guardada no se pudo leer." }, { status: 500 });
    }

    if (
      !payload?.business?.name ||
      !payload?.customer?.name ||
      !Array.isArray(payload?.sale?.items)
    ) {
      return NextResponse.json({ error: "La factura guardada tiene un formato inválido." }, { status: 500 });
    }

    // Enrich payload with taxRate from DB if not already present.
    // Use the same tenant scope already resolved above — never query by invoice
    // relation alone, which would allow cross-tenant taxRate leakage.
    if (payload.business.taxRate == null) {
      const taxRateScope = hasSessionScope
        ? { userId: session!.user!.id }
        : { id: (tokenResult as { businessId: string }).businessId };
      const biz = await prisma.business.findFirst({
        where: taxRateScope,
        select: { taxRate: true },
      });
      if (biz?.taxRate != null) {
        payload.business.taxRate = Number(biz.taxRate);
      }
    }

    // Inject fiscal fields from DB — authoritative after CAE emission.
    // These override any stale or missing values in the stored payloadJson.
    if (row.fiscalTipo != null) {
      payload.fiscalTipo = row.fiscalTipo;
    }
    if (row.caeCode != null) {
      payload.caeCode = row.caeCode;
    }
    if (row.caeFchVto != null) {
      // DB stores as Date (timestamptz); convert to ISO string for the PDF builder.
      payload.caeFchVto = row.caeFchVto.toISOString();
    }
    if (row.fiscalQrUrl != null) {
      payload.fiscalQrUrl = row.fiscalQrUrl;
    }

    const pdfBuffer = await buildInvoicePdf(payload, row.documentType, row.status);
    const filename = `${row.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "") || "factura"}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    cloudLog({ severity: "ERROR", component: "System", action: "INVOICE_PDF_FAILED", a2a_transfer: false, message: "Invoice PDF generation failed", data: { error: error instanceof Error ? error.message : String(error) } });
    return NextResponse.json({ error: "No se pudo generar el PDF de la factura." }, { status: 500 });
  }
}
