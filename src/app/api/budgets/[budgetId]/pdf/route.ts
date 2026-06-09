import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { cloudLog, reportError } from "@/lib/cloud-logger";
import { validatePdfAccessToken } from "@/app/api/_lib/pdf-access";
import { checkRateLimit, unauthorized, badRequest, internalError } from "@/app/api/_lib/route-helpers";
import { buildBudgetPdf, type BudgetPdfData } from "./build-budget-pdf";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ budgetId: string }> }
) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const resolvedParams = await context.params;
  const budgetId = resolvedParams?.budgetId;

  if (!budgetId) {
    return badRequest("Falta el identificador del presupuesto.");
  }

  const session = await auth();
  const tokenResult = validatePdfAccessToken(req, "budget", budgetId);
  if (!session?.user?.id && !tokenResult.valid) {
    return unauthorized();
  }

  // SEC-02: Tenant isolation
  // - Session path: scoped to business.userId
  // - V2 token: scoped to businessId from token
  // - Any other combination has no tenant scope → reject to prevent cross-tenant leak.

  const hasSessionScope = !!session?.user?.id;
  const hasV2TokenScope = tokenResult.valid && tokenResult.version === "v2";

  if (!hasSessionScope && !hasV2TokenScope) {
    return unauthorized();
  }

  try {
    const businessScope = hasSessionScope
      ? { business: { userId: session!.user!.id } }
      : { businessId: (tokenResult as { businessId: string }).businessId };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma client regen blocked on Windows DLL lock; Cloud Build runs prisma generate fresh so prod runtime has shippingCostAmount + paymentLinkUrl.
    const budget = await (prisma as any).budget.findFirst({
      where: {
        id: budgetId,
        ...businessScope,
      },
      select: {
        budgetNumber: true,
        customerName: true,
        currency: true,
        totalAmount: true,
        shippingCostAmount: true,
        paymentLinkUrl: true,
        createdAt: true,
        business: {
          select: {
            name: true,
            cuit: true,
            address: true,
            ivaCondition: true,
            currency: true,
            phone: true,
            whatsappPhone: true,
          },
        },
        items: {
          select: {
            name: true,
            quantity: true,
            unitPrice: true,
          },
        },
      },
    });

    if (!budget) {
      return NextResponse.json(
        { error: "No se encontró el presupuesto." },
        { status: 404 }
      );
    }

    const currency = budget.currency || budget.business.currency;
    const items = budget.items.map((item: { name: string; quantity: number; unitPrice: unknown }) => {
      const unitPrice = Number(item.unitPrice);
      const subtotal = unitPrice * item.quantity;
      return { name: item.name, quantity: item.quantity, unitPrice, subtotal };
    });

    const data: BudgetPdfData = {
      businessName: budget.business.name,
      businessCuit: budget.business.cuit ?? null,
      businessAddress: budget.business.address ?? null,
      businessIvaCondition: budget.business.ivaCondition ?? null,
      businessPhone: budget.business.phone,
      businessWhatsapp: budget.business.whatsappPhone,
      currency,
      budgetNumber: budget.budgetNumber,
      customerName: budget.customerName ?? null,
      customerTaxId: null,
      customerEmail: null,
      customerPhone: null,
      createdAt: budget.createdAt,
      items,
      shippingCost: budget.shippingCostAmount !== null ? Number(budget.shippingCostAmount) : null,
      paymentLinkUrl: budget.paymentLinkUrl ?? null,
      total: Number(budget.totalAmount),
    };

    const pdfBuffer = await buildBudgetPdf(data);
    const safeNumber = budget.budgetNumber.replace(/[^A-Za-z0-9_-]/g, "") || "presupuesto";
    const filename = `Presupuesto-${safeNumber}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    cloudLog({ severity: "ERROR", component: "System", action: "BUDGET_PDF_FAILED", a2a_transfer: false, message: "Budget PDF generation failed", data: { error: error instanceof Error ? error.message : String(error) } });
    reportError(error, { scope: "budgets.pdf" });
    return internalError("No se pudo generar el PDF del presupuesto.");
  }
}
