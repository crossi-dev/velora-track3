// Cobro QR cancellation via chat — extracted from dispatch.ts.
// Called as a pre-check BEFORE detectDeterministicIntent to prevent
// undo_sale from stealing the turn when a pending PaymentIntent exists.

import { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { cancelPaymentIntentUseCase } from "@/app/api/payment-intents/_lib/cancel-payment-intent-use-case";
import { prisma } from "@/lib/prisma";
import { normalizeForMatching } from "../shared";
import type { PreModelIntentParams } from "../router-params";

// Detecta frases de cancelación de cobro QR. Exige al menos uno de los
// verbos cancel/anular/deshacer Y la palabra "cobro"/"pago"/"qr" (o no más
// de 5 tokens en total para "cancelá eso"/"cancelalo" en contexto de cobro).
// Evaluado contra texto ya normalizado (sin tildes, lowercase).
const CANCEL_COBRO_RE =
  /\b(cancel[ao]|cancela(me|lo|la)?|anula|anular|deshar?|deshace|borra)\b.*\b(cobr[oa]|pago|qr|transfer)/i;
const CANCEL_SHORT_RE = /^\s*\b(cancel[ao]|cancela(me|lo|la)?|anula)\b\s*(\b(eso|ese|esto|lo|el cobro)\b)?\s*$/i;

export function looksLikeCancelCobroQrCommand(text: string): boolean {
  const n = normalizeForMatching(text);
  return CANCEL_COBRO_RE.test(n) || CANCEL_SHORT_RE.test(n);
}

/**
 * Handles cobro QR cancellation triggered from chat.
 * Returns NextResponse if handled, null if no pending PaymentIntent found
 * or the outcome is not_found (falls through to normal undo flow).
 */
export async function tryCancelCobroQrFromChat(
  params: Pick<PreModelIntentParams, "businessId" | "actorUserId" | "actorEmployeeId" | "text">,
): Promise<NextResponse | null> {
  if (!looksLikeCancelCobroQrCommand(params.text)) return null;

  const pending = await prisma.paymentIntent.findFirst({
    where: { businessId: params.businessId, estado: "pending" },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) return null;

  const idempotencyKey = `cobro-qr-cancel-chat:${params.businessId}:${pending.id}`;
  const result = await cancelPaymentIntentUseCase({
    businessId: params.businessId,
    actorUserId: params.actorUserId,
    actorEmployeeId: params.actorEmployeeId,
    paymentIntentId: pending.id,
    idempotencyKey,
  });

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "COBRO_QR_CANCEL_CHAT",
    a2a_transfer: false,
    message: `cobro_qr cancel via chat (outcome=${result.outcome})`,
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId ?? undefined,
    data: { paymentIntentId: pending.id, outcome: result.outcome },
  });

  if (result.outcome === "cancelled" || result.outcome === "replayed") {
    return NextResponse.json({
      answer: "Cobro QR cancelado.",
      actions: [{ type: "cobro_qr_cancelled", paymentIntentId: pending.id }],
    });
  }
  if (result.outcome === "not_cancellable") {
    return NextResponse.json({
      answer: `El cobro ya no se puede cancelar (está en estado "${result.estado}").`,
    });
  }
  // not_found / idempotency errors → fall through to normal undo flow
  return null;
}
