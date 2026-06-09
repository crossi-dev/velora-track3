// payments-agent-tools.ts — FunctionTool factories for the payments ADK agent.
// 2026-05-26: create_payment_link now calls registerSaleWithPaymentLinkUseCase —
// invariant "nunca hay link de pago sin venta." [1] Brandur/Stripe DB-first pattern.
// Schema and input type extracted to payments-link-schema.ts (file-size contract).

import { FunctionTool } from "@google/adk";
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
import { createPaymentLinkParams, type CreatePaymentLinkInput } from "./payments-link-schema";
import type { PaymentToolCtx } from "./payments-agent-types";

export function buildCreatePaymentLinkTool(ctx: PaymentToolCtx) {
  return new FunctionTool({
    name: "create_payment_link",
    description:
      "Creates a Sale + Invoice + payment link atomically, then returns a checkout URL " +
      "to share with the customer via WhatsApp. Invariant: every payment link has a Sale. " +
      "The Supervisor must resolve customerId and productId values before calling this tool.",
    parameters: createPaymentLinkParams,
    execute: async (input) => {
      const { customerId, items, description, shippingRequired, destinationPostalCode, destinationAddress, preQuotedShippingCostARS } =
        input as CreatePaymentLinkInput;

      if (!ctx.businessId) return { error: "missing_business_context", currency: "ARS" };
      if (!ctx.actorUserId) return { error: "missing_actor_user_id", currency: "ARS" };
      if (!customerId) return { error: "missing_customer_id", message: "customerId es requerido. El Supervisor debe resolver el ID del cliente antes de llamar a este tool.", currency: "ARS" };
      if (!items || items.length === 0) return { error: "missing_items", message: "items es requerido. Incluí al menos un producto.", currency: "ARS" };

      // V-4: alias/CBU guard. Also fetch courier for shipping Sale row.
      const bizRow = ctx.bizSnapshot ?? await prisma.business.findUnique({
        where: { id: ctx.businessId },
        select: { postalCode: true, paymentProvider: true, alias: true, whatsappPhone: true, cuit: true, courierPreference: true },
      });
      const guardResult = getMissingBusinessData({
        postalCode: bizRow?.postalCode, paymentProvider: bizRow?.paymentProvider,
        alias: bizRow?.alias, whatsappPhone: bizRow?.whatsappPhone, cuit: bizRow?.cuit,
      });
      if (guardResult.paymentLinks.blocked) {
        return { error: "payment_links_blocked", message: guardResult.paymentLinks.ownerPrompt, currency: "ARS" };
      }

      let shippingCostARS: number | null = null;
      let shippingAddressSnapshot: InputJsonValue | null = null;
      let shippingCourierName: string | null = null;

      if (shippingRequired) {
        // Fast path: shipping was already quoted by the Customer Agent and passed in
        // as preQuotedShippingCostARS. Skip resolveShippingQuote (saves ~2s Logística
        // round-trip). Still load the customer address so PaymentIntent.shippingAddress
        // is populated — triggerShipmentCreate reads it after MP confirms payment.
        if (typeof preQuotedShippingCostARS === "number" && preQuotedShippingCostARS > 0) {
          // M2: plausibility cap — same MAX_SHIPPING_ARS as slow path guard.
          const MAX_SHIPPING_ARS = 99_999;
          if (preQuotedShippingCostARS > MAX_SHIPPING_ARS) {
            return { error: "shipping_cost_out_of_range", message: `El costo de envío pre-cotizado (${preQuotedShippingCostARS} ARS) supera el máximo aceptable.`, currency: "ARS" };
          }
          shippingCostARS = preQuotedShippingCostARS;
          const courierPref =
            ctx.bizSnapshot?.courierPreference ??
            (bizRow as { courierPreference?: string | null } | null)?.courierPreference;
          shippingCourierName = courierPref ?? null;
          // Load customer address for the PaymentIntent.shippingAddress snapshot so
          // triggerShipmentCreate has a valid address after MP payment confirmation.
          if (customerId) {
            const cust = await prisma.customer.findFirst({
              where: { id: customerId, businessId: ctx.businessId },
              select: { name: true, address: true, postalCode: true, city: true, phone: true },
            });
            if (cust) {
              shippingAddressSnapshot = {
                name: cust.name ?? "",
                street: cust.address ?? "",
                postalCode: cust.postalCode ?? "",
                city: cust.city ?? "",
                phone: cust.phone ?? "",
              } as unknown as InputJsonValue;
            }
          }
          cloudLog({
            severity: "INFO",
            component: "A2A",
            action: "PAYMENT_LINK_SHIPPING_PRE_QUOTED",
            a2a_transfer: false,
            message: `Shipping used pre-quoted cost: freight=${shippingCostARS} ARS (skipped Logística re-quote)`,
            data: { businessId: ctx.businessId, shippingCostARS, customerId, hasAddress: shippingAddressSnapshot !== null },
          });
        } else {
          // Slow path: no pre-quoted cost — call resolveShippingQuote.
          // Pass customerId directly so resolveShippingQuote can do a findUnique
          // (exact match) instead of a fuzzy name lookup. Customer.postalCode is
          // the SSOT for shipping destination — the DB row already has it.
          const quoteResult = await resolveShippingQuote({
            businessId: ctx.businessId,
            customerId: customerId ?? null,
            inlinePostalCode: destinationPostalCode ?? null,
            inlineAddress: destinationAddress ?? null,
          });

          if (!quoteResult.ok) {
            if (quoteResult.reason === "missing_origin_postal_code") {
              return { error: "missing_origin_postal_code", message: "El negocio no tiene un código postal de origen configurado. Configuralo en Ajustes antes de generar links con envío.", currency: "ARS" };
            }
            if (quoteResult.reason === "missing_destination_postal_code") {
              return { error: "missing_destination_postal_code", message: "Necesito el código postal de destino para cotizar el envío. ¿Cuál es el CP del cliente?", currency: "ARS" };
            }
            return { error: "shipping_quote_failed", message: quoteResult.detail ?? "Error al cotizar el envío.", currency: "ARS" };
          }

          // M2 (security): plausibility cap on shipping before it enters the PI.
          // A buggy/adversarial courier agent must not inflate the total.
          const MAX_SHIPPING_ARS = 99_999;
          if (quoteResult.costARS > MAX_SHIPPING_ARS) {
            return { error: "shipping_cost_out_of_range", message: `El costo de envío cotizado (${quoteResult.costARS} ARS) supera el máximo aceptable. Verificá la configuración del courier.`, currency: "ARS" };
          }

          shippingCostARS = quoteResult.costARS;
          shippingAddressSnapshot = quoteResult.addressSnapshot as unknown as InputJsonValue;
          const courierPref =
            ctx.bizSnapshot?.courierPreference ??
            (bizRow as { courierPreference?: string | null } | null)?.courierPreference;
          shippingCourierName = courierPref ?? null;

          cloudLog({
            severity: "INFO",
            component: "A2A",
            action: "PAYMENT_LINK_SHIPPING_RESOLVED",
            a2a_transfer: false,
            message: `Shipping quote resolved: freight=${shippingCostARS} ARS`,
            data: { businessId: ctx.businessId, shippingCostARS, customerId },
          });
        }
      }

      // [1][2][3] Atomic: Sale + SaleItems + Invoice + PI committed BEFORE calling MP.
      // Total is computed server-side from DB prices + shipping — never from LLM input [4].
      const idempotencyKey = buildLinkIdempotencyKey(ctx.businessId, description, ctx.turnId);
      const courier = (shippingCourierName === "andreani" || shippingCourierName === "oca"
        ? shippingCourierName : null) as "andreani" | "oca" | null;
      const registerInput = { businessId: ctx.businessId, actorUserId: ctx.actorUserId,
        customerId, items, description, idempotencyKey,
        shippingRequired: shippingRequired ?? false, shippingAddress: shippingAddressSnapshot,
        shippingCostARS, shippingCourier: courier };
      const saleResult = isPaymentsOverHttpEnabled()
        ? await callPaymentLinkSaleEndpoint(registerInput)
        : await registerSaleWithPaymentLinkUseCase(registerInput);

      const errorOutcome = mapRegisterSaleOutcomeToError(saleResult);
      if (errorOutcome) return errorOutcome;
      // After errorOutcome guard, saleResult must be created | replayed (both carry paymentIntentId + saleId).
      if (saleResult.outcome !== "created" && saleResult.outcome !== "replayed") {
        return { error: "unexpected_outcome", currency: "ARS" };
      }

      // After narrowing above, saleResult is "created" | "replayed" — both carry paymentIntentId + saleId.
      const dbPaymentIntentId = saleResult.paymentIntentId;
      const dbSaleId = saleResult.saleId;
      const totalARS = saleResult.outcome === "created" ? saleResult.grandTotal : 0;

      if (saleResult.outcome === "replayed") {
        const healResult = await healOrphanedIntent({
          paymentIntentId: dbPaymentIntentId,
          businessId: ctx.businessId,
          description,
          customerName: undefined,
        });
        if ("error" in healResult) return { error: healResult.error, currency: "ARS" };
        if (healResult.healed) {
          const col = healResult.collection;
          // Finding 13: log successful orphan heal for observability.
          cloudLog({
            severity: "INFO",
            component: "A2A",
            action: "PAYMENT_LINK_ORPHAN_HEAL_OK",
            a2a_transfer: false,
            message: `Orphaned intent healed — MP preference re-created successfully`,
            data: { paymentIntentId: dbPaymentIntentId, businessId: ctx.businessId, providerRef: col.providerRef ?? null },
          });
          return {
            sandbox: false,
            preferenceId: col.providerRef ?? null,
            checkoutUrl: col.checkoutUrl ?? null,
            instructions: col.instructions ?? null,
            paymentIntentId: dbPaymentIntentId,
            saleId: dbSaleId,
            amountARS: totalARS,
            shippingCostARS: shippingCostARS ?? 0,
            shippingRequired: shippingRequired ?? false,
            description,
            status: "pending",
            currency: "ARS",
          };
        }
        // Fix 3 + Fix 4: healed=false means the PI row already has a checkoutUrl
        // (set by a previous successful createCollection call). Fetch it plus monto
        // so the return object carries a real checkoutUrl and a non-zero amountARS
        // instead of null + 0, which previously left the Supervisor unable to share
        // the payment link with the customer on the replayed path.
        const existingPI = await prisma.paymentIntent.findUnique({
          where: { id: dbPaymentIntentId, businessId: ctx.businessId },
          select: { checkoutUrl: true, monto: true },
        });
        cloudLog({
          severity: "INFO",
          component: "A2A",
          action: "PAYMENT_LINK_REPLAYED",
          a2a_transfer: false,
          message: "create_payment_link: intent already created (replayed), skipping provider call",
          businessId: ctx.businessId,
          data: { paymentIntentId: dbPaymentIntentId, checkoutUrlFound: Boolean(existingPI?.checkoutUrl) },
        });
        return {
          replayed: true,
          paymentIntentId: dbPaymentIntentId,
          saleId: dbSaleId,
          checkoutUrl: existingPI?.checkoutUrl ?? null,
          amountARS: existingPI?.monto != null ? existingPI.monto.toNumber() : 0,
          message: "El link de pago para esta operación ya fue generado en este turno. Si necesitás enviarlo de nuevo, buscalo en el historial de pagos.",
          currency: "ARS",
        };
      }

      // outcome === "created" — Sale + Invoice + PI committed. Now call MP.
      const mpBreakdown = await resolveSaleItemsForPreference({
        businessId: ctx.businessId,
        paymentIntentId: dbPaymentIntentId,
        shippingCostARS: shippingCostARS ?? null,
        shippingLabel: shippingCostARS ? `Envío — $${shippingCostARS} ARS` : undefined,
      });
      const adapter = await getPaymentProvider(ctx.businessId, ctx.bizSnapshot);
      const collectionResult = await adapter.createCollection({
        paymentIntentId: dbPaymentIntentId,
        amountARS: totalARS,
        description,
        customerName: undefined,
        businessId: ctx.businessId,
        ...(mpBreakdown.items ? { items: mpBreakdown.items } : {}),
        ...(mpBreakdown.shipping ? { shipping: mpBreakdown.shipping } : {}),
        ...(ctx.bizSnapshot?.mpConnectionRaw !== undefined
          ? { prefetchedMpConnection: ctx.bizSnapshot.mpConnectionRaw }
          : {}),
        ...(ctx.bizSnapshot?.name !== undefined
          ? { prefetchedBusinessName: ctx.bizSnapshot.name }
          : {}),
      });

      // Finding 6: log MP adapter failures for observability + SLO alerting.
      if ("error" in collectionResult) {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "MP_COLLECTION_FAILED",
          a2a_transfer: false,
          message: `create_payment_link: MP adapter error — ${collectionResult.error}`,
          data: {
            paymentIntentId: dbPaymentIntentId,
            businessId: ctx.businessId,
            error: collectionResult.error,
            detail: collectionResult.detail ?? null,
          },
        });
        return {
          error: collectionResult.error,
          ...(collectionResult.detail !== undefined ? { message: collectionResult.detail } : {}),
          currency: "ARS",
        };
      }

      return {
        sandbox: false,
        preferenceId: collectionResult.providerRef ?? null,
        checkoutUrl: collectionResult.checkoutUrl ?? null,
        instructions: collectionResult.instructions ?? null,
        paymentIntentId: dbPaymentIntentId,
        saleId: dbSaleId,
        amountARS: totalARS,
        baseAmountARS: totalARS - (shippingCostARS ?? 0),
        shippingCostARS: shippingCostARS ?? 0,
        shippingRequired: shippingRequired ?? false,
        description,
        status: "pending",
        currency: "ARS",
      };
    },
  });
}

// buildGetPaymentStatusTool moved to ./payments-status-tool.ts to keep this
// file under the 300-line limit. Re-exported here for backward compatibility.
export { buildGetPaymentStatusTool } from "./payments-status-tool";
