// AliasCBU adapter — implements PaymentProviderAdapter for manual bank transfers.
// Pure DB-read + format: NO external HTTP calls. Confirmation is manual (owner marks paid).

import { prisma } from "@/lib/prisma";
import type {
  PaymentProviderAdapter,
  CollectionResult,
  PaymentStatusResult,
} from "../payment-provider";

export class AliasCbuAdapter implements PaymentProviderAdapter {
  async createCollection(params: {
    paymentIntentId: string;
    amountARS: number;
    description: string;
    customerName?: string;
    businessId: string;
  }): Promise<CollectionResult | { error: string; detail?: unknown }> {
    const { paymentIntentId, amountARS, businessId } = params;

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { alias: true },
    });

    const alias = business?.alias?.trim() ?? "";
    if (!alias) {
      return {
        error: "no_alias_configured",
        detail:
          "El negocio no tiene alias/CBU configurado. Configuralo en el onboarding o en Ajustes.",
      };
    }

    const formattedAmount = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 2,
    }).format(amountARS);

    const instructions =
      `Pedile al cliente que transfiera ${formattedAmount} al alias ${alias}. ` +
      `Una vez recibida la transferencia, confirmá el pago manualmente en Velora.`;

    // Persist instructions to PaymentIntent so the WA send chip can retrieve
    // them later (alias/CBU has no checkoutUrl — instructions are the delivery).
    // Defense-in-depth: scope by businessId so a cross-tenant paymentIntentId
    // cannot be written even though it was resolved within this tenant's flow.
    // updateMany (not update) because businessId is not part of the PK unique selector.
    await prisma.paymentIntent.updateMany({
      where: { id: paymentIntentId, businessId },
      data: { paymentInstructions: instructions },
    }).catch(() => {
      // Best-effort: if the update fails (e.g. intent not found), still return
      // the result so the agent can relay instructions via prose.
    });

    return {
      paymentIntentId,
      amountARS,
      instructions,
      status: "pending",
      currency: "ARS",
    };
  }

  async getStatus(params: {
    paymentIntentId: string;
    businessId: string;
  }): Promise<PaymentStatusResult> {
    const { paymentIntentId, businessId } = params;

    // Scope by businessId — tenant guard substitute for missing DB-layer RLS.
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: paymentIntentId, businessId },
      select: { estado: true },
    });

    if (!intent) {
      return { paymentIntentId, status: "error", detail: "intent_not_found", currency: "ARS" };
    }

    // Alias/CBU confirmation is manual — map DB estado directly, no external call.
    // Terminal states (cancelled/expired) are distinct from a broken lookup → "rejected".
    const status: PaymentStatusResult["status"] =
      intent.estado === "confirmed"  ? "approved"
      : intent.estado === "pending"  ? "pending"
      : intent.estado === "cancelled" || intent.estado === "expired" ? "rejected"
      : "error";

    return { paymentIntentId, status, detail: intent.estado, currency: "ARS" };
  }
}
