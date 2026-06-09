// trigger-shipment-create — crea un envío de Andreani para un PaymentIntent
// cuyo pago fue confirmado y que tiene shippingRequired = true.
//
// Llama directamente al agente Logística vía A2A JSON-RPC (sendStructured),
// siguiendo el mismo patrón que CallLogisticaAgentTool pero sin el stack ADK.
//
// El actor es "system-mp-webhook" — no hay sesión de owner ni empleado.
// El caller (post-confirm) es responsable del gate de idempotencia
// (shipmentCreatedAt === null) y de estampar shipmentCreatedAt = now() al éxito.

import { prisma } from "@/lib/prisma";
import { sendStructured, A2AClientError } from "@/lib/a2a-client";
import { signAgentAssertion } from "@/lib/agent-identity";
import { deriveA2AKey } from "@/app/api/a2a/jsonrpc/_lib/handle-rpc";
import { cloudLog } from "@/lib/cloud-logger";
import { SHIPMENT_CREATE_TRIGGER_TIMEOUT_MS } from "@/lib/agent-timeouts";
import { getAgentsBaseUrl } from "@/lib/agent-base-url";
import { writeHopShipmentFailed } from "@/app/api/payment-intents/_lib/payment-intent-post-confirm.hop-chat";
import { isAndreaniMockActive } from "@/app/api/agents/andreani/_lib/andreani-mock";

const DEFAULT_WEIGHT_GRAMS = 1_000;

/** Validates that raw JSON is a usable ShippingAddressSnapshot. */
function toShippingAddress(
  raw: unknown,
): { name: string; street: string; postalCode: string; city: string; phone: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.street !== "string" || typeof r.postalCode !== "string") return null;
  return {
    name: typeof r.name === "string" ? r.name : "",
    street: r.street,
    postalCode: r.postalCode,
    city: typeof r.city === "string" ? r.city : "",
    phone: typeof r.phone === "string" ? r.phone : "",
  };
}

/** No-DNI result type — caller logs and skips the shipment. */
export type ShipmentSkipNoDni = { ok: false; reason: "no_dni" };

export type ShipmentCreateResult =
  | { ok: true; agentText: string }
  | { ok: false; reason: string };

/**
 * Resolves the PaymentIntent's shippingAddress and calls the Logística agent
 * with skill="shipment.create". The caller gates this with
 * `shippingRequired && shipmentCreatedAt === null`.
 */
export async function triggerShipmentCreate(
  paymentIntentId: string,
  businessId: string,
): Promise<ShipmentCreateResult> {
  // ── 1. Load intent (single query, tenant-scoped) ──────────────────────────
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: paymentIntentId, businessId },
    select: {
      id: true,
      businessId: true,
      monto: true,
      shippingAddress: true,
      matchedCustomerId: true,
    },
  });

  if (!intent) {
    return { ok: false, reason: "intent_not_found" };
  }

  const addr = toShippingAddress(intent.shippingAddress);
  if (!addr) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "SHIPMENT_CREATE_BAD_ADDRESS",
      a2a_transfer: false,
      message: "shippingAddress missing or malformed — shipment skipped",
      // Log only keys — never raw address blob (PII: street + name + phone).
      data: { paymentIntentId, rawKeys: Object.keys(intent.shippingAddress as object) },
      businessId: intent.businessId,
    });
    return { ok: false, reason: "missing_shipping_address" };
  }

  // ── 2. Mock-mode short-circuit for DNI gate ─────────────────────────────────
  // The DNI null guard below fires BEFORE isAndreaniMockActive() in the Andreani adapter.
  // Substitute a placeholder before the guard so mock flows (demo businesses only) complete
  // end-to-end. Real (non-demo) businesses must supply a real DNI even when the global
  // ANDREANI_MOCK_MODE flag is on.
  const isMockMode = isAndreaniMockActive(businessId);
  const MOCK_DNI_PLACEHOLDER = "99999999";

  // ── 3. Resolve customer DNI — required by Andreani real mode ─────────────────────
  let customerDni: string | null = isMockMode ? MOCK_DNI_PLACEHOLDER : null;
  let customerName: string | null = null;
  if (!isMockMode && intent.matchedCustomerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: intent.matchedCustomerId, businessId },
      select: { dni: true, name: true },
    });
    customerDni = customer?.dni ?? null;
    customerName = customer?.name ?? null;
  }

  if (!customerDni) {
    const displayName = customerName ?? addr.name ?? "el cliente";
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "SHIPMENT_CREATE_NO_DNI",
      a2a_transfer: false,
      message: "Customer DNI missing — shipment skipped. Owner must add DNI to customer record.",
      data: { paymentIntentId, matchedCustomerId: intent.matchedCustomerId ?? null },
      businessId: intent.businessId,
    });
    // Notify the owner in chat; do NOT enqueue cron retry until DNI is added.
    void writeHopShipmentFailed(
      intent.businessId,
      paymentIntentId,
      `falta cargar el DNI del cliente ${displayName}. Cargalo desde el detalle del cliente`,
    );
    return { ok: false, reason: "no_dni" };
  }

  // ── 4. Declared value from the single query above ─────────────────────────
  const declaredValue = Number(intent.monto);

  // ── 5. Build A2A call ─────────────────────────────────────────────────────
  const agentUrl = `${getAgentsBaseUrl()}/api/agents/logistica/jsonrpc`;
  const a2aSecret = process.env.A2A_SECRET ?? "";
  const derivedKey = a2aSecret ? deriveA2AKey(a2aSecret, intent.businessId) : undefined;

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "SHIPMENT_CREATE_DISPATCH",
    a2a_transfer: true,
    message: `Dispatching shipment.create via Logística agent → ${agentUrl}`,
    data: { paymentIntentId, postalCode: addr.postalCode },
    businessId: intent.businessId,
  });

  try {
    const reply = await sendStructured(
      agentUrl,
      {
        skill: "shipment.create",
        businessId: intent.businessId,
        // saleId is null for link-payment flows — provider falls back gracefully.
        saleId: paymentIntentId,
        customer: {
          name: addr.name,
          address: addr.street,
          postalCode: addr.postalCode,
          phone: addr.phone,
          city: addr.city,
          // C-3 FIX: Andreani real mode requires recipient DNI.
          // Validated non-null above — safe to pass here.
          dni: customerDni,
        },
        // Default service for promesa/checkout_pro_link auto-trigger; owner can override via Logística agent.
        service: "domicilio",
        weightGrams: DEFAULT_WEIGHT_GRAMS,
        declaredValue,
      },
      {
        apiKey: derivedKey,
        // Factory — fresh JWT per attempt to prevent JTI replay on retries.
        agentAssertionFactory: () => signAgentAssertion("supervisor", "logistica"),
        timeoutMs: SHIPMENT_CREATE_TRIGGER_TIMEOUT_MS,
      },
    );

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SHIPMENT_CREATE_OK",
      a2a_transfer: false,
      message: `Logística agent responded: ${reply.text.slice(0, 200)}`,
      data: { paymentIntentId },
      businessId: intent.businessId,
    });

    return { ok: true, agentText: reply.text };
  } catch (err) {
    const msg =
      err instanceof A2AClientError
        ? `A2A error (code ${err.code ?? "?"}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "SHIPMENT_CREATE_FAILED",
      a2a_transfer: false,
      message: `Logística agent call failed: ${msg}`,
      data: { paymentIntentId, agentUrl },
      businessId: intent.businessId,
    });

    return { ok: false, reason: msg };
  }
}
