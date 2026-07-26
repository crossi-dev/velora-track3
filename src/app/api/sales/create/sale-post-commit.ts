import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { checkThresholdCrossings } from "@/app/api/planner/_lib/planner-threshold";
import { evaluateConditionBasedRules } from "@/app/api/planner/_lib/condition-stock-rules";
import { publishLowStockFromSale } from "@/app/api/_lib/agent-event-publishers";
import { recordPostCommitFailure } from "@/app/api/_lib/post-commit-failure-tracker";
import { maybeSendIntegrationNudge } from "@/app/api/_lib/onboarding-integration-nudge";
import { writeSaleConfirmationToOwner } from "./sale-confirmation-message";
import { maybeWriteOwnerFirstSalePrimer, maybeWriteEmployeeFirstSalePrimer, maybeStampFirstSaleAt } from "./sale-first-sale-primer";
import { cloudLog, reportError, getTraceStore, runWithTraceStore } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { buildInvoicePdf } from "@/app/api/invoices/[invoiceId]/pdf/build-invoice-pdf";
import { uploadPdfToGcs, getSignedUrlForGcsKey, buildPdfR2Key } from "@/lib/r2";
import { handleFiscalRpc } from "@/app/api/agents/fiscal/jsonrpc/_lib/handle-fiscal-rpc";
import { handlePaymentsRpcAsync } from "@/app/api/agents/payments/jsonrpc/_lib/handle-payments-rpc";
import { handleLogisticaRpc } from "@/app/api/agents/logistica/jsonrpc/_lib/handle-logistica-rpc";
import { sendTransferPaymentRequestWhatsApp } from "./_lib/transfer-payment-request-wa";
import type { InvoicePayload } from "@/infrastructure/shared/sale-invoice";

export interface LowStockAlert {
  productId: string;
  productName: string;
  remainingUnits: number;
  reorderThreshold: number;
}

interface PostCommitArgs {
  businessId: string;
  actorEmployeeId: string | null;
  saleId: string;
  invoiceId: string;
  invoicePayload: InvoicePayload;
  whatsappPhone: string | null | undefined;
  /** Per-owner toggle. Only send low-stock WA alerts when true (default OFF). */
  notifyLowStockWa: boolean;
  lowStockAlerts: LowStockAlert[];
  /** When true, skip sendInvoiceAutoWhatsApp — the client (Path A) handles the
   *  send and has real idempotency. Omitting/false preserves existing behaviour. */
  skipAutoWhatsapp?: boolean;
  /** Payment method for the sale. Used to trigger transfer payment request WA. */
  paymentMethod: string | null;
}

async function sendWithRetry(to: string, body: string, productName: string, meta: { businessId: string; invoiceId: string; saleId: string }): Promise<void> {
  try {
    await sendWhatsAppMessage(to, body);
  } catch (firstErr) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await sendWhatsAppMessage(to, body);
    } catch (secondErr) {
      const secondErrMsg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "LOW_STOCK_WHATSAPP_FAILED",
        a2a_transfer: false,
        message: "low-stock WhatsApp alert failed after retry",
        businessId: meta.businessId,
        data: {
          invoiceId: meta.invoiceId,
          productName,
          firstError: firstErr instanceof Error ? firstErr.message : String(firstErr),
          secondError: secondErrMsg,
        },
      });
      void recordPostCommitFailure({ businessId: meta.businessId, saleId: meta.saleId, action: "LOW_STOCK_WHATSAPP_FAILED", errorMessage: `${productName}: ${secondErrMsg}` });
    }
  }
}

async function sendLowStockAlerts(phone: string, alerts: LowStockAlert[], meta: { businessId: string; invoiceId: string; saleId: string }): Promise<void> {
  const results = await Promise.allSettled(
    alerts.map((alert) =>
      sendWithRetry(
        phone,
        `Stock bajo: ${alert.productName} tiene solo ${alert.remainingUnits} unidades restantes.`,
        alert.productName,
        meta,
      )
    )
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    cloudLog({ severity: "WARNING", component: "System", action: "LOW_STOCK_WHATSAPP_PARTIAL_FAILURE", a2a_transfer: false, message: `${failed.length} of ${results.length} low-stock WhatsApp alerts failed`, businessId: meta.businessId, data: { invoiceId: meta.invoiceId, failedCount: failed.length } });
  }
}

async function sendInvoiceAutoWhatsApp(businessId: string, saleId: string, invoiceId: string, invoicePayload: InvoicePayload): Promise<void> {
  const rawPhone = invoicePayload.customer.phone;
  const customerPhone = typeof rawPhone === "string" ? rawPhone.trim() || null : null;
  if (!customerPhone) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "INVOICE_AUTO_WHATSAPP_SKIPPED",
      a2a_transfer: false,
      message: "invoice auto-send skipped — customer has no phone on file",
      businessId,
      data: { saleId, invoiceId, customerName: invoicePayload.customer.name },
    });
    return;
  }

  let mediaUrl: string | undefined;
  try {
    const pdfBuffer = await buildInvoicePdf(invoicePayload);
    const key = buildPdfR2Key("invoice", businessId, invoiceId, invoicePayload.sale.invoiceNumber);
    const gcsKey = await uploadPdfToGcs(key, pdfBuffer);
    const signedUrl = gcsKey ? await getSignedUrlForGcsKey(gcsKey) : null;
    if (signedUrl) mediaUrl = signedUrl;
  } catch { /* PDF/GCS failure — fall through to text-only */ }

  const label = invoicePayload.sale.invoiceNumber.startsWith("FC-") ? "factura" : "comprobante";
  const text = `¡Hola! Te enviamos el ${label} por tu compra. Atte: ${invoicePayload.business.name}`;
  try {
    await sendWhatsAppMessage(customerPhone, text, mediaUrl);
    await prisma.invoice.updateMany({
      where: { id: invoiceId, businessId, status: { not: "paid" } },
      data: { status: "sent" },
    });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "INVOICE_AUTO_WHATSAPP_SENT",
      a2a_transfer: false,
      message: "invoice auto-send delivered to customer",
      businessId,
      data: { saleId, invoiceId, hasMedia: Boolean(mediaUrl) },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "INVOICE_AUTO_WHATSAPP_FAILED",
      a2a_transfer: false,
      message: "invoice auto-send WhatsApp failed",
      businessId,
      data: { saleId, invoiceId, error: errorMessage },
    });
    void recordPostCommitFailure({ businessId, saleId, action: "INVOICE_AUTO_WHATSAPP_FAILED", errorMessage, originalArgs: { invoiceId } });
  }
}

function buildA2ARpcBody(message: string) {
  return {
    jsonrpc: "2.0" as const,
    id: Date.now().toString(),
    method: "message/send",
    params: { message: { parts: [{ kind: "text", text: message }] } },
  };
}

// Trigger Andreani directly when the sale's customer has the 3 shipping
// fields populated (address + postalCode + dni). Independent of MP/PaymentIntent
// — needed because a plain cash sale or in-store QR cobro never creates a
// PaymentIntent.confirmed event, so the existing post-confirm Andreani path
// would never fire for those sale shapes.
//
// Async payment methods (qr, transferencia): QUOTE only — calls Logística with
// skill=shipment.quote, stores the cost on Sale.shippingQuoteCost so the MP
// preference can include it as a line item. Does NOT create the Andreani order.
// The order is created by payment-intent-post-confirm after webhook fires.
//
// Sync payment methods (efectivo, tarjeta): unchanged — full create flow.
async function triggerLogisticaIfShippingData(
  businessId: string,
  saleId: string,
  invoicePayload: InvoicePayload,
  paymentMethod: string | null,
): Promise<void> {
  const { name: customerName, address, postalCode, dni } = invoicePayload.customer;
  if (!address || !postalCode || !dni) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SALE_LOGISTICA_TRIGGER_SKIPPED",
      a2a_transfer: false,
      message: "logistica agent skipped — customer missing address/postalCode/dni",
      businessId,
      data: {
        saleId,
        customerName,
        hasAddress: Boolean(address),
        hasPostalCode: Boolean(postalCode),
        hasDni: Boolean(dni),
      },
    });
    return;
  }

  const isAsyncPayment = typeof paymentMethod === "string" && ASYNC_PAYMENT_METHODS.has(paymentMethod);

  // ── ASYNC path: quote only, store cost, defer create to post-confirm ─────────
  if (isAsyncPayment) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SALE_LOGISTICA_QUOTE_ONLY",
      a2a_transfer: false,
      message: "logistica quote-only — async payment, shipment.create deferred to post-confirm",
      businessId,
      data: { saleId, paymentMethod },
    });

    const quoteMsg = `Cotizar envío para venta ${saleId}: destinatario ${customerName}, CP ${postalCode}. Solo precio, NO crear orden.`;
    const quoteResult = await Promise.allSettled([
      handleLogisticaRpc(buildA2ARpcBody(quoteMsg), { businessId }),
    ]);

    // Parse cost from agent reply and store on Sale for MP preference builder.
    if (quoteResult[0].status === "fulfilled") {
      try {
        const { extractCheapestPrice } = await import("@/lib/shipping-quote");
        // handleLogisticaRpc returns JsonRpcResponse (result: unknown).
        // The result is the agent's text reply — extract it safely.
        const rpcValue = quoteResult[0].value;
        const resultRaw = rpcValue && typeof rpcValue === "object" && "result" in rpcValue
          ? (rpcValue as { result: unknown }).result
          : null;
        const replyText = typeof resultRaw === "string" ? resultRaw : "";
        const costARS = extractCheapestPrice(replyText);
        if (costARS !== null) {
          await prisma.sale.updateMany({
            where: { id: saleId, businessId },
            data: { shippingQuoteCost: costARS, shippingQuoteCourier: "Andreani" },
          });
          cloudLog({
            severity: "INFO",
            component: "System",
            action: "SALE_SHIPPING_QUOTE_STORED",
            a2a_transfer: false,
            message: `Shipping quote stored on Sale: ARS ${costARS}`,
            businessId,
            data: { saleId, costARS, courier: "Andreani" },
          });
        }
      } catch (parseErr) {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "SALE_SHIPPING_QUOTE_PARSE_FAILED",
          a2a_transfer: false,
          message: "Could not parse shipping quote cost from logistica reply",
          businessId,
          data: { saleId, error: parseErr instanceof Error ? parseErr.message : String(parseErr) },
        });
      }
    } else {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "SALE_LOGISTICA_QUOTE_FAILED",
        a2a_transfer: false,
        message: "Logistica quote-only call failed (non-blocking for async payment)",
        businessId,
        data: { saleId, error: String(quoteResult[0].reason) },
      });
    }
    return;
  }

  // ── SYNC path: full create flow (efectivo, tarjeta) ──────────────────────────

  // C-1 idempotency guard: atomically stamp logisticaTriggeredAt before calling Andreani.
  // Both this path (direct sale) and payment-intent-post-confirm (MP/QR) may fire for the
  // same saleId. The updateMany with "IS NULL" ensures only one caller wins; the other
  // sees count=0 and skips — preventing a duplicate orphan booking at Andreani.
  const stamped = await prisma.sale.updateMany({
    where: { id: saleId, businessId, logisticaTriggeredAt: null },
    data: { logisticaTriggeredAt: new Date() },
  });
  if (stamped.count === 0) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SALE_LOGISTICA_TRIGGER_ALREADY_FIRED",
      a2a_transfer: false,
      message: "logistica trigger skipped — logisticaTriggeredAt already stamped (dedup)",
      businessId,
      data: { saleId },
    });
    return;
  }

  const total = invoicePayload.sale.total;
  const itemsSummary = invoicePayload.sale.items
    .map((i) => `${i.quantity}x ${i.productName}`)
    .join(", ");

  const logisticaMsg = `Crear envío Andreani para venta ${saleId}: destinatario ${customerName}, DNI ${dni}, dirección ${address}, CP ${postalCode}. Contenido: ${itemsSummary}. Monto: $${total}`;

  const logisticaResult = await Promise.allSettled([
    handleLogisticaRpc(buildA2ARpcBody(logisticaMsg), { businessId }),
  ]);

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "SALE_LOGISTICA_TRIGGER",
    a2a_transfer: true,
    message: "Post-sale logistica agent call completed",
    businessId,
    data: {
      saleId,
      customerName,
      // PII omitted from cloudLog — presence flags used instead of plaintext values.
      hasAddress: Boolean(address),
      hasPostalCode: Boolean(postalCode),
      hasDni: Boolean(dni),
      logisticaOk: logisticaResult[0].status === "fulfilled",
      logisticaError: logisticaResult[0].status === "rejected" ? String(logisticaResult[0].reason) : undefined,
    },
  });
}

// Exported so the MCP register_sale path (src/lib/mcp/_lib/sales-mutations.ts)
// can reuse ONLY the fiscal-emission piece in isolation — without pulling in the
// rest of firePostCommitActions' side effects (owner chat confirmation, customer
// WhatsApp, payments/logistica agents, low-stock alerts), which the MCP surface
// deliberately does not perform. This is a self-contained trigger: it carries its
// own async-payment gate, taxId gate, and caeCode idempotency guard.
export async function triggerFiscalIfTaxId(
  businessId: string,
  saleId: string,
  invoiceId: string,
  invoicePayload: InvoicePayload,
  paymentMethod: string | null,
): Promise<void> {
  const { taxId, name: customerName } = invoicePayload.customer;

  // Gate: async payment methods (qr, transferencia) wait for the MP webhook before
  // emitting the comprobante. Emitting pre-pago would produce an orphan AFIP record
  // if the customer never completes the payment — a legal violation under RG 2485.
  // The fiscal emission is already wired in payment-intent-post-confirm.ts →
  // runLinkPaymentPostConfirm → triggerFiscalReceipt.
  if (typeof paymentMethod === "string" && ASYNC_PAYMENT_METHODS.has(paymentMethod)) {
    cloudLog({
      severity: "INFO",
      component: "Fiscal",
      action: "SALE_FISCAL_TRIGGER_DEFERRED",
      a2a_transfer: false,
      message: "fiscal emit deferred — async payment method waits for webhook confirm",
      businessId,
      data: { saleId, invoiceId, paymentMethod, reason: "async_payment_waits_confirm" },
    });
    return;
  }

  if (!taxId) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SALE_FISCAL_TRIGGER_SKIPPED",
      a2a_transfer: false,
      message: "fiscal agent skipped — customer has no taxId",
      businessId,
      data: { saleId, customerName },
    });
    return;
  }

  // Idempotency guard: if a CAE is already recorded on the Invoice row, the
  // AFIP emission already succeeded (possibly on a prior retry). Skip to avoid
  // registering a duplicate comprobante with AFIP — a legal violation under RG 2485.
  //
  // RLS-verify audit: compound where with businessId — OWASP secure-by-default tenant isolation.
  // businessId is already a param in this function's signature.
  const existing = await prisma.invoice.findFirst({
    where: { id: invoiceId, businessId },
    select: { caeCode: true },
  });
  if (existing?.caeCode) {
    cloudLog({
      severity: "INFO",
      component: "Fiscal",
      action: "SALE_FISCAL_TRIGGER_SKIPPED",
      a2a_transfer: false,
      message: "fiscal agent skipped — caeCode already present on Invoice row",
      businessId,
      data: { saleId, invoiceId, caeCode: existing.caeCode, reason: "already_emitted" },
    });
    return;
  }

  const total = invoicePayload.sale.total;
  // Derive invoice tipo from the business IVA condition so the LLM receives the
  // correct type upfront. resolveInvoiceType() at the WSFE layer will enforce the
  // same mapping, but an accurate hint prevents the agent from reasoning over wrong info.
  const ivaCondition = invoicePayload.business?.ivaCondition ?? null;
  const isMonotributista =
    ivaCondition === "MT" || (ivaCondition?.toLowerCase().startsWith("monotrib") ?? false);
  const isExento = ivaCondition === "EX" || (ivaCondition?.toLowerCase().startsWith("exento") ?? false);
  const resolvedTipo = isMonotributista || isExento ? "C" : "B";
  // Audit 2E V2-1: pass Sale.date (YYYY-MM-DD) so the QR uses the actual sale
  // date instead of today's date for backdated sales (AFIP RG 4291 correctness).
  const invoiceDate = new Date(invoicePayload.sale.date).toISOString().slice(0, 10);
  const fiscalMsg = `Emitir factura electrónica tipo ${resolvedTipo}, monto $${total}, cliente ${customerName} CUIT ${taxId}`;
  const fiscalResult = await Promise.allSettled([handleFiscalRpc(buildA2ARpcBody(fiscalMsg), { businessId, invoiceId, invoiceDate })]);

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "SALE_FISCAL_TRIGGER",
    a2a_transfer: true,
    message: "Post-sale fiscal agent call completed",
    businessId,
    data: {
      saleId, invoiceId, customerName, taxId, total,
      fiscalOk: fiscalResult[0].status === "fulfilled",
      fiscalError: fiscalResult[0].status === "rejected" ? String(fiscalResult[0].reason) : undefined,
    },
  });
}

const ASYNC_PAYMENT_METHODS = new Set(["qr", "transferencia"]);

async function triggerPaymentsIfAsyncMethod(
  businessId: string,
  saleId: string,
  invoicePayload: InvoicePayload,
  paymentMethod: string | null | undefined,
): Promise<void> {
  const { taxId, name: customerName } = invoicePayload.customer;
  if (typeof paymentMethod !== "string" || !ASYNC_PAYMENT_METHODS.has(paymentMethod)) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SALE_PAYMENTS_TRIGGER_SKIPPED",
      a2a_transfer: false,
      message: "payments agent skipped — not an async payment method",
      businessId,
      data: { saleId, customerName, paymentMethod: paymentMethod ?? "none", reason: "no_async_method" },
    });
    return;
  }

  const total = invoicePayload.sale.total;
  const firstItemName = invoicePayload.sale.items[0]?.productName ?? "Venta Velora";
  const cuitPart = taxId ? ` CUIT ${taxId}` : "";
  const paymentsMsg = `Crear link de pago $${total}, descripción 'Venta Velora - ${firstItemName}', cliente ${customerName}${cuitPart}`;
  const paymentsResult = await Promise.allSettled([handlePaymentsRpcAsync(buildA2ARpcBody(paymentsMsg), { businessId })]);

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "SALE_PAYMENTS_TRIGGER",
    a2a_transfer: true,
    message: "Post-sale payments agent call completed",
    businessId,
    data: {
      saleId, customerName, total, paymentMethod,
      paymentsOk: paymentsResult[0].status === "fulfilled",
      paymentsError: paymentsResult[0].status === "rejected" ? String(paymentsResult[0].reason) : undefined,
    },
  });
}

export function firePostCommitActions({
  businessId,
  actorEmployeeId,
  saleId,
  invoiceId,
  invoicePayload,
  whatsappPhone,
  notifyLowStockWa,
  lowStockAlerts,
  skipAutoWhatsapp,
  paymentMethod,
}: PostCommitArgs): void {
  // Snapshot trace context BEFORE forking into fire-and-forget async continuations.
  // AsyncLocalStorage store is tied to the originating request's execution context;
  // void promises and setTimeout callbacks run in a NEW scope with no store, so
  // cloudLog calls inside them emit no logging.googleapis.com/trace field and become
  // uncorrelated in Cloud Trace. Snapshotting here and re-entering via runWithTraceStore
  // propagates the correct trace through every post-commit branch.
  const traceStore = getTraceStore();

  // Trace anchor — una línea por venta; acciones individuales emiten sus
  // propios INFO/WARNING filtrables por data.saleId.
  cloudLog({
    severity: "INFO",
    component: "System",
    action: "SALE_POST_COMMIT_DISPATCH",
    a2a_transfer: false,
    message: "Post-commit actions dispatched",
    businessId,
    data: {
      saleId,
      invoiceId,
      customerHasPhone: Boolean(invoicePayload.customer.phone?.trim()),
      customerHasTaxId: Boolean(invoicePayload.customer.taxId?.trim()),
      lowStockCount: lowStockAlerts.length,
      ownerWhatsappConfigured: Boolean(whatsappPhone),
      actorEmployeeId,
    },
  });

  // Sale confirmation → owner chat. Fire-and-forget, dedup por saleId.
  // Va PRIMERO para que el mensaje aparezca antes que cualquier alerta
  // del threshold/condition rules (que tienen 1500ms de delay).
  // actorEmployeeId is forwarded so the push is skipped when the owner
  // is the actor (B3: don't notify owner about their own sale).
  void runWithTraceStore(traceStore, () =>
    writeSaleConfirmationToOwner({ businessId, saleId, invoicePayload, actorEmployeeId })
      .catch((err) => reportError(err, { scope: "sale-post-commit.sale-confirmation" }))
  );
  // Web Push priming primer — write-once por actor (owner via Business flag,
  // employee via Employee flag con mensaje y visibility distinta).
  const primerPromise = actorEmployeeId
    ? maybeWriteEmployeeFirstSalePrimer({ businessId, employeeId: actorEmployeeId, saleId })
    : maybeWriteOwnerFirstSalePrimer({ businessId, saleId });
  void runWithTraceStore(traceStore, () =>
    primerPromise.catch((err) => reportError(err, { scope: "sale-post-commit.first-sale-primer" }))
  );
  // Stamp firstSaleAt on the first sale — provides the idle-window anchor for
  // integration nudges (MP 24h window starts here). Best-effort, never throws.
  void runWithTraceStore(traceStore, () =>
    maybeStampFirstSaleAt({ businessId, saleId })
      .catch((err) => reportError(err, { scope: "sale-post-commit.first-sale-at-stamp" }))
  );

  // Async payment methods (qr, transferencia) defer the PDF to the payment
  // confirm webhook so the customer gets a single unified message with the
  // receipt. Sync methods (efectivo, tarjeta, null) send immediately.
  const asyncPaymentMethods = new Set(["qr", "transferencia"]);
  const isAsyncPayment = typeof paymentMethod === "string" && asyncPaymentMethods.has(paymentMethod);

  if (skipAutoWhatsapp) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SKIP_AUTO_WHATSAPP_BY_CLIENT_REQUEST",
      a2a_transfer: false,
      message: "invoice auto-whatsapp skipped — client is handling the send (Path A)",
      businessId,
      data: { saleId, invoiceId },
    });
  } else if (isAsyncPayment) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "INVOICE_AUTO_WHATSAPP_DEFERRED_TO_PAYMENT_CONFIRM",
      a2a_transfer: false,
      message: "invoice auto-whatsapp deferred — async payment method, will send on payment confirm",
      businessId,
      data: { saleId, invoiceId, paymentMethod },
    });
  } else {
    void runWithTraceStore(traceStore, () =>
      sendInvoiceAutoWhatsApp(businessId, saleId, invoiceId, invoicePayload)
        .catch((err) => reportError(err, { scope: "sale-post-commit.invoice-whatsapp" }))
    );
  }

  // A2A agent triggers run SEQUENTIALLY (not concurrently) to avoid exhausting the
  // pgbouncer connection pool. Each agent (fiscal, payments, logistica) can hold
  // multiple sequential DB connections over 10-28 seconds while waiting for LLM
  // responses. When all three ran in parallel they consumed ~17 pool slots
  // concurrently against a connection_limit=20 pool, starving concurrent sale
  // requests and causing P1001 "Can't reach database server" on fiscal + logistica.
  // Sequential chaining keeps peak pool pressure at ~10 slots (payments max).
  // Wall-time impact is negligible: all three are fire-and-forget from the client.
  //
  // Gate: 250ms delay before starting the agent chain so the fast fire-and-forget
  // DB ops dispatched above (chatMessage.create, business.updateMany, push fan-out)
  // can release their pool slots before fiscal grabs its first connection.
  // sendTransferPaymentRequestWhatsApp moved into this IIFE so it serializes with
  // the agents instead of competing concurrently for pool slots.
  void runWithTraceStore(traceStore, async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try { await sendTransferPaymentRequestWhatsApp(businessId, saleId, invoicePayload, paymentMethod); }
    catch (err) { reportError(err, { scope: "sale-post-commit.transfer-payment-request-wa" }); }
    try { await triggerFiscalIfTaxId(businessId, saleId, invoiceId, invoicePayload, paymentMethod); }
    catch (err) { reportError(err, { scope: "sale-post-commit.fiscal-agent" }); }
    try { await triggerPaymentsIfAsyncMethod(businessId, saleId, invoicePayload, paymentMethod); }
    catch (err) { reportError(err, { scope: "sale-post-commit.payments-agent" }); }
    try { await triggerLogisticaIfShippingData(businessId, saleId, invoicePayload, paymentMethod); }
    catch (err) { reportError(err, { scope: "sale-post-commit.logistica-agent" }); }

    // Event-trigger integration nudges (design §5.iii / §6):
    // Fire AFTER the relevant agent trigger so the nudge lands after the
    // agent response in the owner chat. Exempt from the idle daily cap but
    // still carry slotDate dedup + 48h dismiss gate (design §14.2).
    // maybeSendIntegrationNudge is best-effort and never throws.
    try { await maybeSendIntegrationNudge({ businessId, integration: "mp" }); }
    catch (err) { reportError(err, { scope: "sale-post-commit.mp-nudge" }); }
    // Andreani nudge: only when shipping data was present (owner showed dispatch intent).
    if (invoicePayload.customer.address && invoicePayload.customer.postalCode && invoicePayload.customer.dni) {
      try { await maybeSendIntegrationNudge({ businessId, integration: "andreani" }); }
      catch (err) { reportError(err, { scope: "sale-post-commit.andreani-nudge" }); }
    }
    // ARCA nudge: only when customer had a taxId (owner showed invoice intent).
    if (invoicePayload.customer.taxId) {
      try { await maybeSendIntegrationNudge({ businessId, integration: "arca" }); }
      catch (err) { reportError(err, { scope: "sale-post-commit.arca-nudge" }); }
    }
  });

  // Employee onboarding-transition chat message removed (0 rows in production,
  // Stage 1 cleanup) — actorEmployeeId is always null now, this block was dead.

  if (lowStockAlerts.length === 0) return;

  if (whatsappPhone && notifyLowStockWa) {
    void runWithTraceStore(traceStore, () =>
      sendLowStockAlerts(whatsappPhone, lowStockAlerts, { businessId, invoiceId, saleId }).catch((err) => {
        reportError(err, { scope: "sale-post-commit.low-stock-whatsapp" });
      })
    );
  }

  // 1500ms delay so the Agent 1 sale-confirmation chat message lands before
  // the Agent 2 threshold nudge appears in the owner feed.
  void runWithTraceStore(traceStore, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      await checkThresholdCrossings(businessId, lowStockAlerts);
      void runWithTraceStore(traceStore, () =>
        evaluateConditionBasedRules(businessId, lowStockAlerts).catch((err) =>
          reportError(err, { scope: "sale-post-commit.condition-rules" })
        )
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      reportError(error, { scope: "sale-post-commit.planner-threshold" });
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "PLANNER_THRESHOLD_TRIGGER_FAILED",
        a2a_transfer: false,
        message: "planner threshold trigger failed",
        businessId,
        data: { error: errorMessage },
      });
      void recordPostCommitFailure({ businessId, saleId, action: "PLANNER_THRESHOLD_TRIGGER_FAILED", errorMessage });
    }
  });

  void runWithTraceStore(traceStore, () =>
    publishLowStockFromSale({
      businessId,
      actorEmployeeId,
      saleId,
      alerts: lowStockAlerts.map((a) => ({
        productId: a.productId,
        productName: a.productName,
        remainingUnits: a.remainingUnits,
        reorderThreshold: a.reorderThreshold,
      })),
    }).catch((err) => {
      reportError(err, { scope: "sale-post-commit.low-stock-publish" });
    })
  );
}
