// GET /api/payment-intents/status?id={paymentIntentId}
//
// Lightweight polling endpoint para la card de Cobro QR. El cliente lo pega
// cada ~4s mientras el intent está pending para detectar que el webhook MP
// lo confirmó sin necesidad de que el empleado toque "Marcar cobrado".
//
// Read-only — no muta nada, no usa idempotency. Rate-limit alto (polling).
// Tenant guard: filtra por businessId del actor; never devuelve intents de
// otro tenant.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { bypassIfTester, checkRateLimit, logRouteError, unauthorized, badRequest, notFound, internalError } from "@/app/api/_lib/route-helpers";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();

  // Polling endpoint — quota separada y generosa (60/min por IP).
  const rl = checkRateLimit(req, "payment-intent-status", 60, 60, bypassIfTester(ctx));
  if (rl) return rl;
  // EMPLOYEE_ALLOWED: polling de estado de cobro QR — read-only, sin mutación.
  // El empleado hace polling cada ~4s mientras el intent está pending.
  // (role-contract.ts EMPLOYEE_ALLOWED_INTENTS: "cobro_qr")

  const id = req.nextUrl.searchParams.get("id");
  if (!id || typeof id !== "string" || id.length > 64) {
    return badRequest("Falta o invalid id.");
  }

  try {
    const intent = await prisma.paymentIntent.findFirst({
      where: { id, businessId: ctx.businessId },
      select: {
        id: true,
        estado: true,
        confirmedAt: true,
        expiresAt: true,
        saleId: true,
      },
    });
    if (!intent) return notFound("No se encontró el cobro.");

    // When confirmed and associated to a Sale, look up the Invoice so the
    // client can show "Mandar comprobante" CTA. Also check if the customer
    // has a phone (gate for the button).
    let invoiceId: string | null = null;
    let customerHasPhone: boolean | null = null;

    if (intent.estado === "confirmed" && intent.saleId) {
      const invoice = await prisma.invoice.findFirst({
        where: { saleId: intent.saleId },
        select: {
          id: true,
          sale: {
            select: {
              customer: {
                select: { phone: true },
              },
            },
          },
        },
      });
      if (invoice) {
        invoiceId = invoice.id;
        customerHasPhone = typeof invoice.sale?.customer?.phone === "string" &&
          invoice.sale.customer.phone.trim().length > 0;
      }
    }

    return NextResponse.json({
      paymentIntentId: intent.id,
      estado: intent.estado,
      confirmedAt: intent.confirmedAt ? intent.confirmedAt.toISOString() : null,
      expiresAt: intent.expiresAt ? intent.expiresAt.toISOString() : null,
      saleId: intent.saleId,
      invoiceId,
      customerHasPhone,
    });
  } catch (error) {
    logRouteError("payment-intents/status", error);
    return internalError("No se pudo consultar el cobro.");
  }
}
