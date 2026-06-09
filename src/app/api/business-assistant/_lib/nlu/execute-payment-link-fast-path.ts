import "server-only";
// Executor — Payment Link Fast Path
//
// Dispatches directly to the Payments Agent (via call-ventas-agent-tool logic)
// without waiting for the Supervisor LLM to decide whether to call it.
//
// Flow:
//   1. Pre-resolve amount (injectResolvedAmount) or shipping (resolveVentasShipping)
//      deterministically from the catalog — same logic used inside call_ventas_agent.
//   2. Dispatch to /api/agents/payments/jsonrpc via sendMessage.
//   3. Return a single clean ask: "Link generado para {Name}. ¿Lo envío por WA?"
//      with ONE chip [📲 Enviar a {Name}]. No customer data block, no cancel chip.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendMessage, A2AClientError } from "@/lib/a2a-client";
import { signAgentAssertion } from "@/lib/agent-identity";
import { deriveA2AKey } from "@/app/api/a2a/jsonrpc/_lib/handle-rpc";
import { injectResolvedAmount } from "@/lib/adk/tools/resolve-ventas-amount";
import {
  resolveVentasShipping,
  hasShippingIntent,
  extractCustomerNameFromMessage,
  type CustomerSnapshot,
} from "@/lib/adk/tools/resolve-ventas-shipping";
import type { PaymentLinkBreakdown } from "@/lib/adk/tools/resolve-ventas-breakdown";
import { buildBreakdownText } from "./payment-link-answer-builder";
import type { PaymentLinkFastPathIntent } from "./payment-link-fast-path";
import type { PreModelIntentParams } from "../router-params";
import type { ChipsBundle } from "@/app/api/supervisor/_lib/supervisor-chips";
import { PAYMENT_LINK_FAST_PATH_TIMEOUT_MS } from "@/lib/agent-timeouts";
import { getAgentsBaseUrl } from "@/lib/agent-base-url";
import {
  extractUrl,
  lookupCustomerByName,
  buildPaymentLinkChips,
} from "./execute-payment-link-fast-path-helpers";

export async function executePaymentLinkFastPath(
  intent: PaymentLinkFastPathIntent,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  // Owner-only belt-and-suspenders (PRIORITY_TABLE guard already checked).
  if (params.actorRole !== "owner") {
    return NextResponse.json({
      answer: "Los links de pago los genera el dueño desde su panel.",
    });
  }

  const { businessId } = params;
  const { rawText } = intent;

  // Build catalog snapshot in the shape resolve-ventas-amount expects.
  const products = params.productInfoDirectory.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
  }));

  // Pre-resolve: same two-path logic as call_ventas_agent.execute().
  let resolvedMessage = rawText;
  let customerSnapshot: CustomerSnapshot | null = null;
  let paymentBreakdown: PaymentLinkBreakdown | null = null;

  if (products.length > 0) {
    if (hasShippingIntent(rawText)) {
      // Part A: Guard — require a valid business postal code before resolving shipping.
      // If missing, ask the owner now; the reply is captured by business_postal_reply_fast_path.
      const biz = await prisma.business.findUnique({
        where: { id: businessId },
        select: { postalCode: true },
      });
      const { isValidPostalCode } = await import("@/lib/shipping-quote");
      if (!isValidPostalCode(biz?.postalCode)) {
        return NextResponse.json({
          answer:
            "Antes de generar el link necesito el código postal de tu negocio — " +
            "lo uso para cotizar el envío con Andreani. " +
            "¿Cuál es el código postal de tu negocio? (por ejemplo: 5500)",
        });
      }
      const result = await resolveVentasShipping(rawText, businessId, products);
      resolvedMessage = result.message;
      customerSnapshot = result.customerSnapshot;
      paymentBreakdown = result.breakdown;

      // JIT prompt: if the only blocker is a missing destination CP, ask now.
      // Never ask twice — execute-business-postal-reply handles the reply and
      // resumes this fast path automatically via seamless resume.
      if (result.needsDestinationCP) {
        const firstName = result.cpCustomerName?.split(" ")[0] ?? result.cpCustomerName ?? "el cliente";
        return NextResponse.json({
          answer:
            `Para cotizar el envío necesito el código postal de ${firstName}. ` +
            `¿Cuál es el CP de ${firstName}? (por ejemplo: 5500)`,
        });
      }
    } else {
      resolvedMessage = injectResolvedAmount(rawText, products);
    }
  }

  // For the non-shipping path, look up the customer separately.
  if (!customerSnapshot) {
    const customerName = extractCustomerNameFromMessage(rawText);
    if (customerName) {
      customerSnapshot = await lookupCustomerByName(businessId, customerName).catch(() => null);
    }
  }

  const agentUrl = `${getAgentsBaseUrl()}/api/agents/payments/jsonrpc`;
  const fullMessage = `businessId: ${businessId}\n${resolvedMessage}`;
  const a2aSecret = process.env.A2A_SECRET ?? "";
  const derivedKey = a2aSecret ? deriveA2AKey(a2aSecret, businessId) : undefined;

  cloudLog({
    severity: "INFO",
    component: "Supervisor",
    action: "ADK_A2A_VENTAS_CALL",
    a2a_transfer: true,
    message: `payment-link fast path → ${agentUrl}`,
    data: { businessId, source: "deterministic_fast_path" },
  });

  try {
    const reply = await sendMessage(agentUrl, fullMessage, {
      apiKey: derivedKey,
      // Use agentAssertionFactory (not a pre-computed string) so that each retry
      // attempt gets a fresh JWT with a new JTI. Without this, a retry after a
      // mid-flight abort would send the same JTI that the payments route already
      // consumed, triggering ASSERTION_JTI_REPLAY → AUTH_REQUIRED.
      // Root cause logged 2026-05-27 incident: ADK_A2A_VENTAS_FAILED after
      // A2A_RETRY_RECOVERED when first attempt aborted ("This operation was aborted").
      agentAssertionFactory: () => signAgentAssertion("supervisor", "payments"),
      // 30s aligns with the Payments agent's ADK runner timeout (28s) plus a
      // small buffer. The previous 12s killed legitimate Pro turns that took
      // ~15s end-to-end (Pro is slower than Flash; the inner shipping-quote
      // call adds 1-3s; under load the function-call round trip can spike).
      // Resulting "Network error" surfaced to the owner even though the agent
      // was about to return a valid checkoutUrl.
      timeoutMs: PAYMENT_LINK_FAST_PATH_TIMEOUT_MS,
    });

    const replyText = reply.text ?? "";
    // Prefer structured data from the A2A response (set by handle-payments-rpc from
    // the create_payment_link tool result) over fragile URL extraction from prose.
    const paymentData = (reply.dataParts as Array<{ paymentIntentId?: string; checkoutUrl?: string }>)
      .find((d) => d.paymentIntentId);
    let paymentIntentId = paymentData?.paymentIntentId ?? null;
    let checkoutUrl = paymentData?.checkoutUrl ?? extractUrl(replyText);

    // Fallback: if structured dataParts didn't carry paymentIntentId (ADK event
    // ordering edge case), look up the most recent PaymentIntent for this customer
    // created within the last 30s — the agent just created it synchronously above.
    if (!paymentIntentId && customerSnapshot?.id) {
      const recent = await prisma.paymentIntent.findFirst({
        where: {
          businessId,
          matchedCustomerId: customerSnapshot.id,
          checkoutUrl: { not: null },
          createdAt: { gte: new Date(Date.now() - 30_000) },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, checkoutUrl: true },
      }).catch(() => null);
      if (recent) {
        paymentIntentId = recent.id;
        checkoutUrl = checkoutUrl ?? recent.checkoutUrl;
      }
    }

    // Diagnostic log — surfaces chip-drop root cause in Cloud Logging.
    // Each field maps to a potential failure mode:
    //   customerSnapshot=null → name extraction failed or customer not in DB
    //   paymentIntentId=null  → dataParts empty AND fallback DB returned nothing
    //   phone=null            → customer has no phone on file
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "PAYMENT_LINK_CHIP_STATE",
      a2a_transfer: false,
      message: "payment-link chip decision state",
      data: {
        businessId,
        customerSnapshot: customerSnapshot
          ? { id: customerSnapshot.id, name: customerSnapshot.name, hasPhone: !!customerSnapshot.phone }
          : null,
        paymentIntentId,
        hasDataParts: paymentData != null,
        fallbackRan: !paymentData && !!customerSnapshot?.id,
      },
    });

    // Step 1: single clean ask — no raw agent text, no customer data block.
    let answer = replyText;
    let chips: ChipsBundle | null = null;

    if (customerSnapshot) {
      const firstName = customerSnapshot.name.split(" ")[0] ?? customerSnapshot.name;
      if (paymentIntentId) {
        chips = buildPaymentLinkChips(customerSnapshot, paymentIntentId);
        const breakdownSection = paymentBreakdown ? `\n\n${buildBreakdownText(paymentBreakdown)}` : "";
        if (chips) {
          answer = `Link de pago generado para ${firstName}.${breakdownSection}\n\n¿Lo envío por WhatsApp al ${customerSnapshot.phone}?`;
        } else {
          // No phone on file — show a minimal message with the URL so the owner can copy it.
          const urlForDisplay = checkoutUrl ?? "";
          answer = `Link de pago generado para ${firstName}.${breakdownSection}${urlForDisplay ? `\n\n${urlForDisplay}` : ""}\n\nPara enviarlo por WhatsApp, primero cargá el teléfono en el panel de clientes.`;
        }
      }
    }

    return NextResponse.json({
      answer,
      ...(chips ? { chips } : {}),
      agentActivity: [
        {
          agentId: "payments",
          agentLabel: "Payments Agent",
          icon: "💳",
          action: "link de pago generado",
          latencyMs: 0,
        },
      ],
    });
  } catch (err) {
    // 429 from the Payments Agent means the rate limit was hit (20 payment links/min
    // per business). This can happen when two requests fire simultaneously (e.g. rapid
    // retry or postal-code resume path). Return a user-friendly message instead of the
    // raw HTTP error code so the owner knows to wait a moment and try again.
    const is429 = err instanceof A2AClientError && err.code === 429;
    const errMsg = is429
      ? "Demasiadas solicitudes de link de pago en poco tiempo. Esperá un momento y volvé a intentarlo."
      : err instanceof A2AClientError
        ? `Error al generar el link de pago: ${err.message}`
        : err instanceof Error
          ? `Error al generar el link de pago: ${err.message}`
          : "El agente de pagos no está disponible.";

    cloudLog({
      severity: is429 ? "WARNING" : "ERROR",
      component: "Supervisor",
      action: "ADK_A2A_VENTAS_FAILED",
      a2a_transfer: false,
      message: errMsg,
      businessId,
      data: { agentUrl, code: err instanceof A2AClientError ? err.code : undefined },
    });

    return NextResponse.json({ answer: errMsg });
  }
}
