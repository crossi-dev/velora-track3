import "server-only";
// pagos-crear-link-pago.execute.ts — Execute body for pagos.crear_link_pago.
// Extracted from pagos-crear-link-pago-tool.ts to honour the 250-line limit
// for new server files. All logic is verbatim from payments-agent-tools.ts
// (create_payment_link execute) — zero behaviour change.

import type { InputJsonValue } from "@prisma/client/runtime/library";
import { getPaymentProvider } from "./payment-provider";
import { registerSaleWithPaymentLinkUseCase } from "@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case";
import { callPaymentLinkSaleEndpoint, isPaymentsOverHttpEnabled } from "./payment-link-sale-writeback";
import { resolveShippingQuote } from "./shipping-quote";
import { cloudLog } from "@/lib/cloud-logger";
import { healOrphanedIntent } from "./payment-link-orphan-heal";
import { getMissingBusinessData } from "@velora/core-utils/missing-business-data";
import { prisma } from "@/lib/prisma";
import { buildLinkIdempotencyKey } from "./adk-payments-agent";
import { resolveSaleItemsForPreference } from "./mp-preference-sale-items";
import { mapRegisterSaleOutcomeToError } from "./payments-agent-tools.outcome-map";
import type { PaymentToolCtx } from "./payments-agent-types";
import type { ToolResult } from "@/lib/adk/tools/_shared/create-tool";

export type CrearLinkPagoInput = {
  customerId: string;
  items: Array<{ productId: string; quantity: number; unitPriceOverride?: number }>;
  description: string;
  shippingRequired?: boolean;
  destinationPostalCode?: string;
  destinationAddress?: string;
  preQuotedShippingCostARS?: number;
};

export async function executeCrearLinkPago(
  input: CrearLinkPagoInput,
  backend: PaymentToolCtx,
): Promise<ToolResult> {
  const {
    customerId, items, description, shippingRequired,
    destinationPostalCode, destinationAddress, preQuotedShippingCostARS,
  } = input;

  if (!backend.businessId) {
    return { error: { code: "missing_business_context", message: "Missing business context" } };
  }
  if (!backend.actorUserId) {
    return { error: { code: "missing_actor_user_id", message: "Missing actor user id" } };
  }
  if (!customerId) {
    return { error: { code: "missing_customer_id", message: "customerId es requerido. El Supervisor debe resolver el ID del cliente antes de llamar a este tool." } };
  }
  if (!items || items.length === 0) {
    return { error: { code: "missing_items", message: "items es requerido. Incluí al menos un producto." } };
  }

  // V-4: alias/CBU guard. Also fetch courier for shipping Sale row.
  const bizRow = backend.bizSnapshot ?? await prisma.business.findUnique({
    where: { id: backend.businessId },
    select: { postalCode: true, paymentProvider: true, alias: true, whatsappPhone: true, cuit: true, courierPreference: true },
  });
  const guardResult = getMissingBusinessData({
    postalCode: bizRow?.postalCode, paymentProvider: bizRow?.paymentProvider,
    alias: bizRow?.alias, whatsappPhone: bizRow?.whatsappPhone, cuit: bizRow?.cuit,
  });
  if (guardResult.paymentLinks.blocked) {
    return { error: { code: "payment_links_blocked", message: guardResult.paymentLinks.ownerPrompt } };
  }

  let shippingCostARS: number | null = null;
  let shippingAddressSnapshot: InputJsonValue | null = null;
  let shippingCourierName: string | null = null;

  if (shippingRequired) {
    if (typeof preQuotedShippingCostARS === "number" && preQuotedShippingCostARS > 0) {
      // Fast path: shipping already quoted upstream — skip Logística re-quote.
      // M2: plausibility cap — same MAX_SHIPPING_ARS as slow path guard.
      const MAX_SHIPPING_ARS = 99_999;
      if (preQuotedShippingCostARS > MAX_SHIPPING_ARS) {
        return { error: { code: "shipping_cost_out_of_range", message: `El costo de envío pre-cotizado (${preQuotedShippingCostARS} ARS) supera el máximo aceptable.` } };
      }
      shippingCostARS = preQuotedShippingCostARS;
      const courierPref =
        backend.bizSnapshot?.courierPreference ??
        (bizRow as { courierPreference?: string | null } | null)?.courierPreference;
      shippingCourierName = courierPref ?? null;
      const cust = await prisma.customer.findFirst({
        where: { id: customerId, businessId: backend.businessId },
        select: { name: true, address: true, postalCode: true, city: true, phone: true },
      });
      if (cust) {
        shippingAddressSnapshot = {
          name: cust.name ?? "", street: cust.address ?? "",
          postalCode: cust.postalCode ?? "", city: cust.city ?? "", phone: cust.phone ?? "",
        } as unknown as InputJsonValue;
      }
      cloudLog({
        severity: "INFO", component: "A2A", action: "PAYMENT_LINK_SHIPPING_PRE_QUOTED",
        a2a_transfer: false,
        message: `Shipping used pre-quoted cost: freight=${shippingCostARS} ARS (skipped Logística re-quote)`,
        data: { businessId: backend.businessId, shippingCostARS, customerId, hasAddress: shippingAddressSnapshot !== null },
      });
    } else {
      // Slow path: call resolveShippingQuote.
      const quoteResult = await resolveShippingQuote({
        businessId: backend.businessId,
        customerId: customerId ?? null,
        inlinePostalCode: destinationPostalCode ?? null,
        inlineAddress: destinationAddress ?? null,
      });
      if (!quoteResult.ok) {
        if (quoteResult.reason === "missing_origin_postal_code") {
          return { error: { code: "missing_origin_postal_code", message: "El negocio no tiene un código postal de origen configurado. Configuralo en Ajustes antes de generar links con envío." } };
        }
        if (quoteResult.reason === "missing_destination_postal_code") {
          return { error: { code: "missing_destination_postal_code", message: "Necesito el código postal de destino para cotizar el envío. ¿Cuál es el CP del cliente?" } };
        }
        return { error: { code: "shipping_quote_failed", message: quoteResult.detail ?? "Error al cotizar el envío." } };
      }
      // M2 (security): plausibility cap on shipping before it enters the PI.
      const MAX_SHIPPING_ARS = 99_999;
      if (quoteResult.costARS > MAX_SHIPPING_ARS) {
        return { error: { code: "shipping_cost_out_of_range", message: `El costo de envío cotizado (${quoteResult.costARS} ARS) supera el máximo aceptable. Verificá la configuración del courier.` } };
      }
      shippingCostARS = quoteResult.costARS;
      shippingAddressSnapshot = quoteResult.addressSnapshot as unknown as InputJsonValue;
      const courierPref =
        backend.bizSnapshot?.courierPreference ??
        (bizRow as { courierPreference?: string | null } | null)?.courierPreference;
      shippingCourierName = courierPref ?? null;
      cloudLog({
        severity: "INFO", component: "A2A", action: "PAYMENT_LINK_SHIPPING_RESOLVED",
        a2a_transfer: false,
        message: `Shipping quote resolved: freight=${shippingCostARS} ARS`,
        data: { businessId: backend.businessId, shippingCostARS, customerId },
      });
    }
  }

  // [1][2][3] Atomic: Sale + SaleItems + Invoice + PI committed BEFORE calling MP.
  const idempotencyKey = buildLinkIdempotencyKey(backend.businessId, description, backend.turnId);
  const courier = (shippingCourierName === "andreani" || shippingCourierName === "oca"
    ? shippingCourierName : null) as "andreani" | "oca" | null;
  const registerInput = {
    businessId: backend.businessId, actorUserId: backend.actorUserId,
    customerId, items, description, idempotencyKey,
    shippingRequired: shippingRequired ?? false, shippingAddress: shippingAddressSnapshot,
    shippingCostARS, shippingCourier: courier,
  };
  const saleResult = isPaymentsOverHttpEnabled()
    ? await callPaymentLinkSaleEndpoint(registerInput)
    : await registerSaleWithPaymentLinkUseCase(registerInput);

  const errorOutcome = mapRegisterSaleOutcomeToError(saleResult);
  if (errorOutcome) {
    return { error: { code: errorOutcome.error, message: errorOutcome.message ?? errorOutcome.error } };
  }
  if (saleResult.outcome !== "created" && saleResult.outcome !== "replayed") {
    return { error: { code: "unexpected_outcome", message: "Unexpected sale outcome" } };
  }

  const dbPaymentIntentId = saleResult.paymentIntentId;
  const dbSaleId = saleResult.saleId;
  const totalARS = saleResult.outcome === "created" ? saleResult.grandTotal : 0;

  if (saleResult.outcome === "replayed") {
    return executeReplayedPath(dbPaymentIntentId, dbSaleId, totalARS, shippingCostARS, shippingRequired, description, backend.businessId);
  }

  // outcome === "created" — Sale + Invoice + PI committed. Now call MP.
  return executeCreatedPath(dbPaymentIntentId, dbSaleId, totalARS, shippingCostARS, shippingRequired, description, backend);
}

async function executeReplayedPath(
  dbPaymentIntentId: string,
  dbSaleId: string,
  totalARS: number,
  shippingCostARS: number | null,
  shippingRequired: boolean | undefined,
  description: string,
  businessId: string,
): Promise<ToolResult> {
  const healResult = await healOrphanedIntent({
    paymentIntentId: dbPaymentIntentId, businessId, description, customerName: undefined,
  });
  if ("error" in healResult) {
    return { error: { code: healResult.error, message: healResult.error } };
  }
  if (healResult.healed) {
    const col = healResult.collection;
    cloudLog({
      severity: "INFO", component: "A2A", action: "PAYMENT_LINK_ORPHAN_HEAL_OK",
      a2a_transfer: false,
      message: "Orphaned intent healed — MP preference re-created successfully",
      data: { paymentIntentId: dbPaymentIntentId, businessId, providerRef: col.providerRef ?? null },
    });
    return {
      sandbox: false, preferenceId: col.providerRef ?? null,
      checkoutUrl: col.checkoutUrl ?? null, instructions: col.instructions ?? null,
      paymentIntentId: dbPaymentIntentId, saleId: dbSaleId, amountARS: totalARS,
      shippingCostARS: shippingCostARS ?? 0, shippingRequired: shippingRequired ?? false,
      description, status: "pending" as const, currency: "ARS" as const,
    };
  }
  // healed=false: PI row already has a checkoutUrl from a previous successful call.
  const existingPI = await prisma.paymentIntent.findUnique({
    where: { id: dbPaymentIntentId, businessId },
    select: { checkoutUrl: true, monto: true },
  });
  cloudLog({
    severity: "INFO", component: "A2A", action: "PAYMENT_LINK_REPLAYED",
    a2a_transfer: false,
    message: "pagos.crear_link_pago: intent already created (replayed), skipping provider call",
    businessId,
    data: { paymentIntentId: dbPaymentIntentId, checkoutUrlFound: Boolean(existingPI?.checkoutUrl) },
  });
  return {
    replayed: true as const, paymentIntentId: dbPaymentIntentId, saleId: dbSaleId,
    checkoutUrl: existingPI?.checkoutUrl ?? null,
    amountARS: existingPI?.monto != null ? existingPI.monto.toNumber() : 0,
    message: "El link de pago para esta operación ya fue generado en este turno. Si necesitás enviarlo de nuevo, buscalo en el historial de pagos.",
    currency: "ARS" as const,
  };
}

async function executeCreatedPath(
  dbPaymentIntentId: string,
  dbSaleId: string,
  totalARS: number,
  shippingCostARS: number | null,
  shippingRequired: boolean | undefined,
  description: string,
  backend: PaymentToolCtx,
): Promise<ToolResult> {
  const mpBreakdown = await resolveSaleItemsForPreference({
    businessId: backend.businessId!,
    paymentIntentId: dbPaymentIntentId,
    shippingCostARS: shippingCostARS ?? null,
    shippingLabel: shippingCostARS ? `Envío — $${shippingCostARS} ARS` : undefined,
  });
  const adapter = await getPaymentProvider(backend.businessId!, backend.bizSnapshot);
  const collectionResult = await adapter.createCollection({
    paymentIntentId: dbPaymentIntentId, amountARS: totalARS, description,
    customerName: undefined, businessId: backend.businessId!,
    ...(mpBreakdown.items ? { items: mpBreakdown.items } : {}),
    ...(mpBreakdown.shipping ? { shipping: mpBreakdown.shipping } : {}),
    ...(backend.bizSnapshot?.mpConnectionRaw !== undefined
      ? { prefetchedMpConnection: backend.bizSnapshot.mpConnectionRaw } : {}),
    ...(backend.bizSnapshot?.name !== undefined
      ? { prefetchedBusinessName: backend.bizSnapshot.name } : {}),
  });

  if ("error" in collectionResult) {
    cloudLog({
      severity: "WARNING", component: "A2A", action: "MP_COLLECTION_FAILED",
      a2a_transfer: false,
      message: `pagos.crear_link_pago: MP adapter error — ${collectionResult.error}`,
      data: { paymentIntentId: dbPaymentIntentId, businessId: backend.businessId!,
        error: collectionResult.error, detail: String(collectionResult.detail ?? "") || null },
    });
    return { error: { code: collectionResult.error, message: (typeof collectionResult.detail === "string" ? collectionResult.detail : null) ?? collectionResult.error } };
  }

  return {
    sandbox: false, preferenceId: collectionResult.providerRef ?? null,
    checkoutUrl: collectionResult.checkoutUrl ?? null, instructions: collectionResult.instructions ?? null,
    paymentIntentId: dbPaymentIntentId, saleId: dbSaleId, amountARS: totalARS,
    baseAmountARS: totalARS - (shippingCostARS ?? 0),
    shippingCostARS: shippingCostARS ?? 0, shippingRequired: shippingRequired ?? false,
    description, status: "pending" as const, currency: "ARS" as const,
  };
}
