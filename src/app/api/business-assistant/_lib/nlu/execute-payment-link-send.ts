import "server-only";
// Executor — Payment Link Send / Cancel
//
// Handles the chip outcome that follows the payment-link ask card:
//
//   enviar_link_pago|{phone}|{paymentIntentId}
//     → resolves checkoutUrl from the PaymentIntent DB row
//     → sends the MP checkout URL to the customer via WhatsApp
//     → returns a single clean confirmation: "✅ Link enviado a {Name} por WhatsApp."
//
//   cancelar_link_pago (legacy — chip no longer shown, kept for safety)
//     → does nothing (idempotent acknowledgement)
//     → returns a short acknowledgement
//
// These are machine-token messages submitted when the owner taps a chip —
// they are never typed by a human, so the detector is an exact prefix/match.

import { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { sendCustomerPaymentLink } from "@/app/api/agents/communications/jsonrpc/_lib/handle-communications-rpc";
import { prisma } from "@/lib/prisma";
import type { PreModelIntentParams } from "../router-params";
import type {
  PaymentLinkSendIntent,
  PaymentLinkCancelIntent,
} from "./types";

// ── Send ─────────────────────────────────────────────────────────────────────

export async function executePaymentLinkSend(
  intent: PaymentLinkSendIntent,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  if (params.actorRole !== "owner") {
    return NextResponse.json({
      answer: "Los links de pago los envía el dueño.",
    });
  }

  const { phone, paymentIntentId } = intent;

  // Resolve checkout URL + amount + sale reference from the PaymentIntent row.
  // The mp-adapter persists checkoutUrl; alias-cbu persists paymentInstructions.
  const row = await prisma.paymentIntent
    .findFirst({
      where: { id: paymentIntentId, businessId: params.businessId },
      select: {
        checkoutUrl: true,
        paymentInstructions: true,
        matchedCustomerId: true,
        monto: true,
        saleId: true,
      },
    })
    .catch(() => null);

  const url = row?.checkoutUrl ?? null;
  const aliasInstructions = row?.paymentInstructions ?? null;

  // Best-effort customer name lookup for the confirmation message.
  let customerFirstName: string | null = null;
  if (row?.matchedCustomerId) {
    const customer = await prisma.customer
      .findUnique({ where: { id: row.matchedCustomerId }, select: { name: true } })
      .catch(() => null);
    customerFirstName = customer?.name?.split(" ")[0] ?? null;
  }

  // Best-effort sale description: first product name from the linked sale.
  let saleDescription: string | null = null;
  if (row?.saleId) {
    const saleItems = await prisma.saleItem
      .findMany({
        where: { saleId: row.saleId },
        select: { quantity: true, product: { select: { name: true } } },
        take: 3,
      })
      .catch(() => [] as { quantity: number; product: { name: string } | null }[]);
    if (saleItems.length > 0) {
      const parts = saleItems
        .filter((i) => i.product?.name)
        .map((i) => (i.quantity > 1 ? `${i.quantity} ${i.product!.name}` : i.product!.name));
      if (parts.length > 0) {
        saleDescription = parts.length > 2
          ? `${parts.slice(0, 2).join(", ")} y más`
          : parts.join(", ");
      }
    }
  }

  // Format amount in ARS.
  const montoFormatted = row?.monto != null
    ? new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(
        Number(row.monto),
      )
    : null;

  // Build the intermediate Velora landing URL so WhatsApp renders a rich
  // 1200×630 OG preview instead of MP's default 200×200 thumbnail.
  // The landing page auto-redirects to the MP checkout after 3 s.
  const BASE_URL =
    process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://somosvelora.com";

  function buildVeloraLandingUrl(intentId: string): string {
    return `${BASE_URL}/pay/${intentId}`;
  }

  // Compose the WhatsApp message with available context.
  function buildWappMessage(intentId: string): string {
    const landingUrl = buildVeloraLandingUrl(intentId);
    if (customerFirstName && montoFormatted && saleDescription) {
      return `Hola ${customerFirstName}! Te paso el link para pagar ${montoFormatted} por ${saleDescription}: ${landingUrl}`;
    }
    if (customerFirstName && montoFormatted) {
      return `Hola ${customerFirstName}! Tu link de pago de ${montoFormatted}: ${landingUrl}`;
    }
    if (montoFormatted) {
      return `Tu link de pago de ${montoFormatted}: ${landingUrl}`;
    }
    return `Tu link de pago: ${landingUrl}`;
  }

  // Alias/CBU path: no checkoutUrl, but paymentInstructions are the delivery.
  if (aliasInstructions && !url) {
    const aliasMsg = customerFirstName
      ? `Hola ${customerFirstName}! ${aliasInstructions}`
      : aliasInstructions;
    try {
      await sendWhatsAppMessage(phone, aliasMsg);
      cloudLog({
        severity: "INFO",
        component: "Supervisor",
        action: "PAYMENT_ALIAS_WA_SENT",
        a2a_transfer: false,
        message: "Alias/CBU payment instructions sent via WhatsApp",
        data: { businessId: params.businessId, phone, paymentIntentId },
      });
      return NextResponse.json({
        answer: `✅ Instrucciones de transferencia enviadas a ${customerFirstName ?? phone} por WhatsApp.`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      cloudLog({
        severity: "WARNING",
        component: "Supervisor",
        action: "PAYMENT_ALIAS_WA_SEND_FAILED",
        a2a_transfer: false,
        message: "Failed to send alias/CBU instructions via WhatsApp",
        data: { businessId: params.businessId, phone, paymentIntentId, error: detail },
      });
      return NextResponse.json({
        answer: `No pude enviar las instrucciones por WhatsApp: ${detail}. Copiá las instrucciones manualmente desde arriba.`,
      });
    }
  }

  if (!url) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "PAYMENT_LINK_URL_NOT_FOUND",
      a2a_transfer: false,
      message: "checkoutUrl not found for PaymentIntent — cannot send via WhatsApp",
      data: { businessId: params.businessId, paymentIntentId },
    });
    return NextResponse.json({
      answer: "No encontré el link de pago. Es posible que haya expirado. Generá uno nuevo.",
    });
  }

  // Route through Comms agent (single source of truth for customer-facing WPP).
  // Direct import is canonical for in-process calls within the same Cloud Run
  // service per Google ADK A2A 2026 — mirrors the sendCustomerTrackingWpp pattern.
  const result = await sendCustomerPaymentLink({
    businessId: params.businessId,
    customerPhone: phone,
    customerName: customerFirstName,
    paymentIntentId,
    checkoutUrl: url,
    monto: row?.monto != null ? Number(row.monto) : null,
    saleDescription,
  });

  if (result.ok) {
    return NextResponse.json({
      answer: `✅ Link enviado a ${customerFirstName ?? phone} por WhatsApp.`,
    });
  } else {
    return NextResponse.json({
      answer: `No pude enviar el link por WhatsApp: ${result.error ?? "error desconocido"}. El link sigue disponible arriba para copiarlo manualmente.`,
    });
  }
}

// ── Cancel ───────────────────────────────────────────────────────────────────

export function executePaymentLinkCancel(
  _intent: PaymentLinkCancelIntent,
  _params: PreModelIntentParams,
): NextResponse {
  return NextResponse.json({
    answer:
      "Dale, no lo envié. El link sigue disponible arriba si lo querés mandar después.",
  });
}
