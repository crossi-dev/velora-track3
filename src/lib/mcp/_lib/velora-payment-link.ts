// src/lib/mcp/_lib/velora-payment-link.ts — createTrackedPaymentLink adapter implementation.
//
// Extracted from payment-link-mutations.ts (was handleCreateTrackedPaymentLink) to satisfy
// the 300-line budget on both files and to place the money logic behind the PaymentsBackend
// port rather than directly in the MCP handler.
//
// This file contains the VERBATIM business logic from the original handler — same inputs
// produce identical Sale + Invoice + PaymentIntent + MP link. No behavioral change.
//
// Dependency chain (unchanged):
//   registerSaleWithPaymentLinkUseCase  — atomic DB write (Sale + Invoice + PaymentIntent)
//   getPaymentProvider                  — payment provider adapter factory (MP, alias, etc.)
//   healOrphanedIntent                  — orphan-heal on idempotent replay with no providerRef
//   resolveSaleItemsForPreference       — builds MP preference item breakdown from DB
//   mapRegisterSaleOutcomeToError       — maps use-case outcome → domain error discriminant
//   getMissingBusinessData              — V-4 alias/CBU pre-flight guard
//   isAutoApprovalEnabled               — Entrega 1 approval-gate seam (always false today)
//
// SECURITY: tenantId (businessId) comes from the port input, which in turn is set by the
// tool handler's closure from the auth gate — NEVER from model-supplied tool arguments.
// NABAOS: the total is derived server-side from DB prices × quantities inside the use-case.
// unitPriceOverride is accepted (negotiated line prices) and is capped at 10× catalog price
// by the use-case (NABAOS M2). No model-supplied total ever reaches the payment provider.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { registerSaleWithPaymentLinkUseCase } from "@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case";
import { getPaymentProvider } from "@/app/api/agents/payments/jsonrpc/_lib/payment-provider";
import { healOrphanedIntent } from "@/app/api/agents/payments/jsonrpc/_lib/payment-link-orphan-heal";
import { resolveSaleItemsForPreference } from "@/app/api/agents/payments/jsonrpc/_lib/mp-preference-sale-items";
import { mapRegisterSaleOutcomeToError } from "@/app/api/agents/payments/jsonrpc/_lib/payments-agent-tools.outcome-map";
import { isAutoApprovalEnabled } from "./approval-gate";
import { getMissingBusinessData } from "@velora/core-utils/missing-business-data";
import { MCP_ACTOR_USER_ID } from "./sales-mutations";
import type { CreateTrackedPaymentLinkInput, CreateTrackedPaymentLinkResult } from "./payments-backend.port";

// ── Domain helpers ────────────────────────────────────────────────────────────

/** Maps the payment-provider adapter's error keys to domain error discriminants. */
function mapAdapterErrorCode(error: string): string {
  switch (error) {
    case "payment_provider_not_connected": return "mp_not_connected";
    case "payment_provider_token_expired":  return "mp_token_expired";
    case "payment_token_decrypt_error":    return "mp_decrypt_error";
    default:                               return "mp_api_error";
  }
}

/** Maps adapter error key to the owner-facing message (matches original strings verbatim). */
function mapAdapterErrorMessage(error: string): string {
  switch (error) {
    case "payment_provider_not_connected":
      return "MercadoPago no está conectado. Configurá tu cuenta en Ajustes para generar links de cobro.";
    case "payment_provider_token_expired":
      return "La sesión de MercadoPago expiró. Reconectá tu cuenta en Ajustes.";
    case "payment_token_decrypt_error":
      return "No pudimos leer tus credenciales de MercadoPago. Contactá soporte.";
    default:
      return "No se pudo crear el link de cobro. Intentá de nuevo o contactá soporte.";
  }
}

// ── Adapter implementation (verbatim logic from handleCreateTrackedPaymentLink) ──

/**
 * Implements PaymentsBackend.createTrackedPaymentLink for the Velora adapter.
 * All money logic is preserved VERBATIM from the original handler; this is a
 * structural extraction, not a behavioral change.
 */
export async function createTrackedPaymentLinkImpl(
  input: CreateTrackedPaymentLinkInput,
): Promise<CreateTrackedPaymentLinkResult> {
  const { tenantId: businessId, customerId, items, description, idempotencyKey } = input;

  try {
    // ── Approval-gate seam (telemetry + reserved toggle for Entrega 2) ──────────
    // Same call site as the original handler — see payment-link-mutations.ts header.
    const autoApproval = await isAutoApprovalEnabled(businessId);
    cloudLog({
      severity: "INFO", component: "A2A", action: "PAYMENT_WIZARD_APPROVAL_GATE",
      a2a_transfer: false, message: "createTrackedPaymentLink approval-gate check",
      businessId, data: { autoApproval },
    });

    const expiresInDays = input.expiresInDays ?? 3;

    // ── V-4: alias/CBU pre-flight guard (mirrors pagos-crear-link-pago.execute.ts) ─
    const bizRow = await prisma.business.findUnique({
      where: { id: businessId },
      select: { postalCode: true, paymentProvider: true, alias: true, whatsappPhone: true, cuit: true },
    });
    const guardResult = getMissingBusinessData({
      postalCode: bizRow?.postalCode,
      paymentProvider: bizRow?.paymentProvider,
      alias: bizRow?.alias,
      whatsappPhone: bizRow?.whatsappPhone,
      cuit: bizRow?.cuit,
    });
    if (guardResult.paymentLinks.blocked) {
      return { domainError: "payment_links_blocked", errorMessage: guardResult.paymentLinks.ownerPrompt };
    }

    // ── [1] Atomic DB write FIRST (Sale + Invoice + PaymentIntent) ─────────────
    const saleResult = await registerSaleWithPaymentLinkUseCase({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      customerId,
      items,
      description,
      idempotencyKey,
    });

    const errOutcome = mapRegisterSaleOutcomeToError(saleResult);
    if (errOutcome) {
      return { domainError: errOutcome.error, errorMessage: errOutcome.message };
    }
    if (saleResult.outcome !== "created" && saleResult.outcome !== "replayed") {
      return { domainError: "unexpected_outcome", errorMessage: "Resultado inesperado al registrar la venta." };
    }

    const paymentIntentId = saleResult.paymentIntentId;

    // ── Replayed (same idempotencyKey) → orphan-heal or return existing link ──
    if (saleResult.outcome === "replayed") {
      const heal = await healOrphanedIntent({ paymentIntentId, businessId, description, expiresInDays });
      if ("error" in heal) {
        if (heal.error === "intent_not_found" || heal.error === "invalid_amount") {
          return { domainError: heal.error, errorMessage: "No pudimos recuperar el cobro original. Contactá soporte." };
        }
        return { domainError: mapAdapterErrorCode(heal.error), errorMessage: mapAdapterErrorMessage(heal.error) };
      }
      if (heal.healed) {
        return { paymentLinkUrl: heal.collection.checkoutUrl ?? null, paymentIntentId, amountARS: heal.collection.amountARS };
      }
      // Healthy replay: providerRef already set — read back the existing link.
      const existing = await prisma.paymentIntent.findUnique({
        where: { id: paymentIntentId, businessId },
        select: { checkoutUrl: true, monto: true },
      });
      if (!existing?.checkoutUrl) {
        return { domainError: "missing_checkout_url", errorMessage: "El link ya se había generado pero no está disponible. Contactá soporte." };
      }
      return {
        paymentLinkUrl: existing.checkoutUrl,
        paymentIntentId,
        amountARS: existing.monto != null ? existing.monto.toNumber() : 0,
      };
    }

    // ── [2] outcome === "created": DB committed, now create the MP link ────────
    const totalARS = saleResult.grandTotal;
    const mpBreakdown = await resolveSaleItemsForPreference({
      businessId,
      paymentIntentId,
      shippingCostARS: null,
    });
    const adapter = await getPaymentProvider(businessId);
    const collection = await adapter.createCollection({
      paymentIntentId,
      amountARS: totalARS,
      description,
      businessId,
      expiresInDays,
      ...(mpBreakdown.items ? { items: mpBreakdown.items } : {}),
    });

    if ("error" in collection) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "PAYMENT_WIZARD_MP_COLLECTION_FAILED",
        a2a_transfer: false, message: `createTrackedPaymentLink MP error — ${collection.error}`,
        businessId, data: { paymentIntentId, error: collection.error },
      });
      return { domainError: mapAdapterErrorCode(collection.error), errorMessage: mapAdapterErrorMessage(collection.error) };
    }

    return { paymentLinkUrl: collection.checkoutUrl ?? null, paymentIntentId, amountARS: totalARS };
  } catch (err) {
    cloudLog({
      severity: "ERROR", component: "A2A", action: "PAYMENT_WIZARD_WRITE_TOOL_ERROR",
      a2a_transfer: false, message: "createTrackedPaymentLink threw",
      businessId, data: { error: err instanceof Error ? err.message : String(err) },
    });
    // Re-throw so the tool handler's outer try/catch can build the MCP isError response.
    throw err;
  }
}
