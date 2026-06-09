// trigger-fiscal-receipt — invoca el agente Fiscal (eslabón 4 del flujo norte)
// para emitir el comprobante post-pago y enviar el texto resultante al cliente
// por WhatsApp.
//
// Patrón de invocación: idéntico a call-contador-agent-tool.ts.
//   - signing: deriveA2AKey(A2A_SECRET, businessId) + signAgentAssertion
//   - protocolo: sendMessage (texto plano) — el Fiscal Agent NO usa sendStructured
//   - primera línea del mensaje: "businessId: <id>" (contrato del agente Fiscal)
//
// El agente Fiscal devuelve texto plano narrando CAE + vencimiento (sandbox o real).
// Ese texto se reenvía al cliente por WhatsApp, reutilizando la resolución de
// teléfono ya presente en send-payment-receipt.ts.
//
// La idempotencia (gate por comprobanteSentAt) y el stamp en DB son
// responsabilidad del caller (payment-intent-post-confirm.ts).

import { prisma } from "@/lib/prisma";
import { sendMessage, A2AClientError } from "@/lib/a2a-client";
import { signAgentAssertion } from "@/lib/agent-identity";
import { deriveA2AKey } from "@/app/api/a2a/jsonrpc/_lib/handle-rpc";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { cloudLog } from "@/lib/cloud-logger";
import { FISCAL_RECEIPT_TRIGGER_TIMEOUT_MS } from "@/lib/agent-timeouts";
import { getAgentsBaseUrl } from "@/lib/agent-base-url";
import { isAgentFallbackText } from "./fiscal-receipt-guards";
import { buildStructuredReceiptText } from "./trigger-fiscal-receipt.text";
import { buildAndAttachReceiptPdf } from "./trigger-fiscal-receipt.pdf";
import { routeFiscalOwnerOnly, routeFiscalFallback } from "./trigger-fiscal-receipt.routes";

const DEFAULT_CUSTOMER_CUIT = "20-00000000-0";

/** Mirrors ReceiptSendResult for drop-in compatibility with the caller. */
export type FiscalReceiptResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Loads the PaymentIntent, calls the Fiscal Agent to emit the comprobante,
 * and sends the agent's narrative text to the customer by WhatsApp.
 *
 * Returns { ok: true } when the WhatsApp send succeeds (or when there is no
 * customer phone — treated as a non-error to avoid infinite retries).
 * Returns { ok: false, reason } on any Fiscal Agent or network error so the
 * caller can leave comprobanteSentAt = null for cron retry.
 */
export async function triggerFiscalReceipt(
  paymentIntentId: string,
  postConfirmRunId?: string,
  businessId?: string,
): Promise<FiscalReceiptResult> {
  // Finding #4: fail-fast when A2A_SECRET is absent — unsigned calls always 401
  // and would spin indefinitely in the retry cron without a distinct log.
  // Treat as non-retryable (caller must add "a2a_secret_missing" to skip list).
  const a2aSecret = process.env.A2A_SECRET ?? "";
  if (!a2aSecret) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "FISCAL_A2A_SECRET_MISSING",
      a2a_transfer: false,
      message: "A2A_SECRET env var is not set — fiscal receipt cannot be signed; aborting (non-retryable)",
      data: { paymentIntentId, postConfirmRunId: postConfirmRunId ?? null },
    });
    return { ok: false, reason: "a2a_secret_missing" };
  }
  // ── 1. Load PaymentIntent + customer in a single round-trip ──────────────
  // Finding #7: collapse two sequential findUnique (PI then Customer) into one
  // Prisma include. Reference: prisma.io/docs/orm/prisma-client/queries/select-fields
  // (2026) — include reduces N+1 patterns and DB round-trips.
  // RLS-verify audit: findFirst with compound where — OWASP secure-by-default tenant isolation.
  const intent = await prisma.paymentIntent.findFirst({
    where: businessId ? { id: paymentIntentId, businessId } : { id: paymentIntentId },
    select: {
      id: true,
      businessId: true,
      monto: true,
      matchedCustomerId: true,
      saleId: true,
      confirmedAt: true,
      business: { select: { name: true } },
      // Audit 2E V2-1: load Sale.date so the fiscal QR uses the actual sale
      // date instead of today for backdated sales (AFIP RG 4291 correctness).
      sale: { select: { date: true } },
      matchedCustomer: { select: { name: true, phone: true, taxId: true } },
    },
  });

  if (!intent) {
    return { ok: false, reason: "intent_not_found" };
  }

  // ── 2. Resolve customer phone + CUIT via matchedCustomer relation ───────────
  let phone: string | null = null;
  let customerName = "Cliente";
  let customerCuit = DEFAULT_CUSTOMER_CUIT;

  if (intent.matchedCustomer) {
    phone = intent.matchedCustomer.phone ?? null;
    customerName = intent.matchedCustomer.name;
    if (intent.matchedCustomer.taxId) customerCuit = intent.matchedCustomer.taxId;
  }

  if (!phone) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "FISCAL_RECEIPT_SKIP_NO_PHONE",
      a2a_transfer: false,
      message: "No customer phone — fiscal receipt skipped (treated as ok)",
      data: { paymentIntentId },
      businessId: intent.businessId,
    });
    // No phone → treat as success so comprobanteSentAt is stamped and we don't retry forever.
    return { ok: true };
  }

  // ── 3. Build agent URL + signing material ─────────────────────────────────
  const agentUrl = `${getAgentsBaseUrl()}/api/agents/fiscal/jsonrpc`;
  // a2aSecret already validated non-empty above (Finding #4 guard).
  const derivedKey = deriveA2AKey(a2aSecret, intent.businessId);

  // ── 4. Compose message — fiscal agent contract ────────────────────────────
  // First line MUST be "businessId: <id>" (handle-fiscal-rpc.ts extractBusinessIdFromText).
  // "invoiceDate: YYYY-MM-DD" is extracted by extractInvoiceDateFromText so the
  // Fiscal Agent QR uses the actual sale date (Audit 2E V2-1 — AFIP RG 4291).
  const amountARS = Number(intent.monto);
  const concept = `Pago recibido — ${intent.business?.name ?? "Velora"}`;
  const saleDate = intent.sale?.date;
  const invoiceDateLine = saleDate
    ? `invoiceDate: ${new Date(saleDate).toISOString().slice(0, 10)}`
    : null;
  const messageLines = [
    `businessId: ${intent.businessId}`,
    ...(invoiceDateLine ? [invoiceDateLine] : []),
    `Emitir comprobante tipo C para CUIT ${customerCuit}, monto ARS ${amountARS}, concepto: ${concept}.`,
  ];
  const message = messageLines.join("\n");

  // PDPA / Ley 25.326: redact CUIT to last-4. "no-cuit" when DEFAULT_CUSTOMER_CUIT
  // to avoid "0000" false-positive in audit (JD Fix #4). Ref: cloud.google.com/logging/docs/structured-logging#redacting-pii
  const customerCuitLast4 = customerCuit === DEFAULT_CUSTOMER_CUIT
    ? "no-cuit"
    : customerCuit.replace(/\D/g, "").slice(-4);
  cloudLog({
    severity: "INFO",
    component: "System",
    action: "FISCAL_RECEIPT_DISPATCH",
    a2a_transfer: true,
    message: `Dispatching emit_invoice via Fiscal agent → ${agentUrl}`,
    data: { paymentIntentId, customerCuitLast4, amountARS, postConfirmRunId: postConfirmRunId ?? null },
    businessId: intent.businessId,
  });

  // ── 5. Call Fiscal Agent ──────────────────────────────────────────────────
  let agentText: string;
  let isSandboxReply = false;
  let emitInvoiceResult: Record<string, unknown> | null = null;
  try {
    const reply = await sendMessage(agentUrl, message, {
      apiKey: derivedKey,
      // Factory — fresh JWT per attempt to prevent JTI replay on retries.
      agentAssertionFactory: () => signAgentAssertion("supervisor", "fiscal"),
      timeoutMs: FISCAL_RECEIPT_TRIGGER_TIMEOUT_MS,
    });
    agentText = reply.text;
    // Google 2026 standard — structured dataParts, never prose substring scan.
    // sandboxUsed and emitInvoiceResult travel as typed JSON metadata so caller
    // can branch on facts (sandbox-vs-real, CAE present, setup-guidance present)
    // without depending on Gemini's free-form wording.
    for (const part of reply.dataParts) {
      if (part !== null && typeof part === "object") {
        const data = part as Record<string, unknown>;
        if (data.sandboxUsed === true) isSandboxReply = true;
        if (data.emitInvoiceResult && typeof data.emitInvoiceResult === "object") {
          emitInvoiceResult = data.emitInvoiceResult as Record<string, unknown>;
        }
      }
    }
  } catch (err) {
    const msg =
      err instanceof A2AClientError
        ? `Fiscal Agent A2A error (code ${err.code ?? "?"}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "FISCAL_RECEIPT_AGENT_FAILED",
      a2a_transfer: false,
      message: `Fiscal Agent call failed: ${msg}`,
      data: { paymentIntentId, agentUrl },
      businessId: intent.businessId,
    });
    return { ok: false, reason: msg };
  }

  // ── 6. Forward agent text to customer via WhatsApp ────────────────────────
  // Google 2026 standard: route on structured dataPart flag, not LLM prose.
  // `emit_invoice` tool returns `setupGuidance` when business is not yet ARCA-ready
  // (fiscal-readiness.ts). The agent transcribes that guidance prose, and the
  // old `containsOwnerContent(agentText)` substring scan would route owner-only
  // even in sandbox mode — suppressing the customer PDF that the sandbox CAE
  // legitimately produces. Now we gate on the structured `setupGuidance` field
  // inside `emitInvoiceResult` AND only when not sandbox: sandbox CAE is a valid
  // receipt regardless of real-ARCA setup state.
  const hasSetupGuidance =
    emitInvoiceResult !== null &&
    typeof emitInvoiceResult.setupGuidance === "string" &&
    (emitInvoiceResult.setupGuidance as string).length > 0;
  // Tier-2 common args — passed to both route helpers so they can attach comprobante interno PDF.
  const tier2Args = { saleId: intent.saleId, monto: amountARS, confirmedAt: intent.confirmedAt };
  if (hasSetupGuidance && !isSandboxReply) {
    // Returns ok:false so caller rolls back comprobanteSentAt → retry cron re-enters
    // after ARCA credentials are set up. Was ok:true → permanent suppression (JD Fix #3).
    return await routeFiscalOwnerOnly({ paymentIntentId, businessId: intent.businessId, customerName, phone, agentText, ...tier2Args });
  }

  // Defensive guard: empty / known-fallback agentText → comprobante interno PDF, no leak.
  const isEmptyReply = !agentText || agentText.trim() === "";
  const isFallbackReply = isAgentFallbackText(agentText);
  if (isEmptyReply || isFallbackReply) {
    return await routeFiscalFallback({ paymentIntentId, businessId: intent.businessId, customerName, phone, agentText, ...tier2Args });
  }

  // ── 7. Attempt PDF — best-effort, falls back to text-only on any failure ────
  let mediaUrl: string | undefined;
  try {
    mediaUrl = await buildAndAttachReceiptPdf({
      paymentIntentId,
      businessId: intent.businessId,
      saleId: intent.saleId,
      monto: amountARS,
      customerName,
      phone,
      confirmedAt: intent.confirmedAt,
    });
  } catch {
    // Non-fatal — proceed with text-only
  }

  // Build the receipt body from structured tool result when available (Google 2026
  // standard — never depend on LLM prose for facts). Falls back to agentText when
  // emit_invoice did not run (rare; only when the model failed to call the tool
  // and we already passed the empty/fallback guards above).
  const receiptBody = emitInvoiceResult !== null
    ? buildStructuredReceiptText(emitInvoiceResult, isSandboxReply)
    : agentText;
  const greeting = `¡Hola ${customerName}! Tu comprobante de pago:\n\n`;
  const wapText = greeting + receiptBody;

  try {
    await sendWhatsAppMessage(phone, wapText, mediaUrl, intent.businessId);
  } catch (sendErr) {
    const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "FISCAL_RECEIPT_WHATSAPP_FAILED",
      a2a_transfer: false,
      message: `Fiscal receipt WhatsApp send failed: ${msg}`,
      data: { paymentIntentId, phone: `...${phone.slice(-4)}` },
      businessId: intent.businessId,
    });
    return { ok: false, reason: msg };
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "FISCAL_RECEIPT_SENT",
    a2a_transfer: false,
    message: `Fiscal receipt sent (last4=…${phone.slice(-4)}, pdfAttached=${Boolean(mediaUrl)})`,
    // Finding #2: isSandboxReply added for observability.
    data: { paymentIntentId, pdfAttached: Boolean(mediaUrl), isSandboxReply, postConfirmRunId: postConfirmRunId ?? null },
    businessId: intent.businessId,
  });

  return { ok: true };
}
