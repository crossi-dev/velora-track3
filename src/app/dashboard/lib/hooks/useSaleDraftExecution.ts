"use client";

import { clearMutationKeysForAction } from "./utils";
import { resolveSaleWhatsappRecipient } from "../sale-whatsapp-recipient";
import { executeDashboardAction } from "../actions/executeDashboardAction";
import { getAppSettings } from "../appSettings";
import { validateAndNormalizeSaleDraftForCommit } from "../actions/saleDraftNode";
import { runCanonicalInvoiceWhatsappSend } from "./useSalesInvoices";
import {
  dispatchSaleCompletion,
  type SaleCompletionEvent,
  type SaleCompletionWhatsapp,
} from "../sale-completion-event";
import { triggerConfirmFeedback } from "../sounds/play-confirm-beep";
import { useDashboardLang } from "../DashboardLangContext";
import type {
  ChatHistoryEntry,
  ChipsBundle,
  ParsedSale,
  FeedbackNotice,
  Product,
  ContactRow,
  InvoicePayload,
} from "../types";

/* ------------------------------------------------------------------ */
/*  Options                                                           */
/* ------------------------------------------------------------------ */

export interface UseSaleDraftExecutionOptions {
  businessId: string | null;
  locale: string;
  currency?: string;
  products: Product[];
  clients: ContactRow[];
  setInput: (value: string) => void;
  setUndoAction?: (fn: (() => Promise<void>) | null) => void;
  setFreshInvoiceId?: (id: string | null) => void;
  notifyChatSuccess?: (msg: string) => void;
  setConfirmError: (msg: string | null) => void;
  setInvoiceStatusNotice: (msg: FeedbackNotice | null) => void;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string, chips?: ChipsBundle | null) => void;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  downloadInvoicePdf: (id: string, num: string) => void;
  assistantConfirmationSubmitting: boolean;
  setAssistantConfirmationSubmitting: (v: boolean) => void;
  clearStaleSaleDraftPrompt?: () => void;

  /* Provided by the orchestrator from parsing sub-hook */
  clearSharedSaleDraft: () => void;
  /** Current parsed sale draft — used as fallback when no draftOverride is provided */
  getParsed: () => ParsedSale | null;
  /** Generation counter — bumped on every draft open/cancel so stale async
   *  operations (WhatsApp sends, error messages) can detect they are no
   *  longer relevant and suppress their side-effects. */
  saleFlowGenRef: { current: number };
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useSaleDraftExecution(opts: UseSaleDraftExecutionOptions) {
  const {
    businessId,
    locale,
    products,
    clients,
    setUndoAction,
    setFreshInvoiceId,
    notifyChatSuccess,
    setConfirmError,
    setInvoiceStatusNotice,
    appendChatHistoryEntry,
    loadBusiness,
    downloadInvoicePdf,
    clearSharedSaleDraft,
    clearStaleSaleDraftPrompt,
  } = opts;
  const { t } = useDashboardLang();

  /* ---- send invoice via WhatsApp -------------------------------- */
  // Pure side-effect: returns the result, does NOT emit toasts or chat
  // bubbles. The caller assembles a SaleCompletionEvent and dispatches once.
  // External callers (e.g. useAssistantActions) that need their own toast
  // can read .ok / .message and emit themselves.

  async function sendInvoiceToCustomer(
    invoiceId: string,
    invoiceNumber: string,
    selectedCustomerPhone?: string | null,
    invoicePayload?: InvoicePayload | null,
  ) {
    try {
      const data = await runCanonicalInvoiceWhatsappSend({
        businessId,
        invoiceId,
        invoiceNumber,
        phone: selectedCustomerPhone,
        payload: invoicePayload,
        loadBusiness,
      });
      return { ok: true as const, message: data.successMessage };
    } catch (err) {
      const rawMsg = err instanceof Error
        ? err.message
        : t("Could not send the invoice via WhatsApp. Check the number with country prefix (e.g. +54911...).", "No se pudo enviar la factura por WhatsApp. Verificá el número con prefijo de país (ej: +54911...).");
      const errMsg = rawMsg.includes("no tiene un teléfono") || rawMsg.includes("teléfono de cliente")
        ? t("This customer has no phone number. Add one in Contacts first.", "El cliente no tiene teléfono. Agregá un teléfono en Contactos primero.")
        : rawMsg;
      return { ok: false as const, message: errMsg };
    }
  }

  /* ---- save sale to backend ------------------------------------- */

  async function saveAssistantSale(draftOverride?: ParsedSale | null, skipAutoWhatsapp?: boolean) {
    const saleDraft = draftOverride ?? opts.getParsed();
    if (!saleDraft || !businessId) return null;
    const salePrefs = getAppSettings();
    const normalized = validateAndNormalizeSaleDraftForCommit(saleDraft, products, {
      allowNegativeStock: salePrefs.allowNegativeStock,
    });
    if (!normalized.ok) throw new Error(normalized.error);

    const draft = normalized.value;
    const data = await executeDashboardAction("sale.create", {
      businessId,
      customerId: draft.customer?.id || null,
      defaultCustomerName: salePrefs.defaultCustomer || "Consumidor Final",
      allowNegativeStock: salePrefs.allowNegativeStock,
      items: draft.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      total: draft.total,
      locale,
      paymentMethod: draft.paymentMethod ?? "efectivo",
      skipAutoWhatsapp: skipAutoWhatsapp ?? undefined,
    });

    return data as { sale?: { id: string }; invoice?: { id: string; invoiceNumber: string; payload: InvoicePayload } };
  }

  /* ---- full confirm flow ---------------------------------------- */

  async function runSaleConfirmFlow(
    sendWhatsapp: boolean,
    preOpenedWindow?: Window | null,
    draftOverride?: ParsedSale | null
  ): Promise<{ ok: boolean; invoiceId?: string | null }> {
    const effectiveDraft = draftOverride ?? opts.getParsed();
    if (opts.assistantConfirmationSubmitting) return { ok: false, invoiceId: null };
    const confirmPrefs = getAppSettings();
    if (!confirmPrefs.allowSaleWithoutCustomer && !effectiveDraft?.customer?.id) {
      setConfirmError(t("Select a customer before confirming.", "Seleccioná un cliente antes de confirmar."));
      return { ok: false, invoiceId: null };
    }

    // Snapshot the current generation so we can detect if a newer sale flow
    // superseded this one while we were awaiting (e.g. during the WhatsApp delay).
    const flowGen = opts.saleFlowGenRef.current;
    const isStale = () => opts.saleFlowGenRef.current !== flowGen;

    opts.setAssistantConfirmationSubmitting(true);
    setConfirmError(null);
    // When the flow turns stale mid-execution (a newer sale opened), we must
    // NOT clear submitting — doing so re-enables the confirm button on the NEW
    // flow and allows a double-execution. The new flow owns the submitting state.
    let skipClearSubmitting = false;
    try {
      // Pass skipAutoWhatsapp=true when the client will handle the send via
      // Path A (invoice send endpoint). This prevents Path B (server auto-send)
      // from firing a duplicate WhatsApp to the customer.
      const result = await saveAssistantSale(effectiveDraft, sendWhatsapp);

      if (result) {
        const { customerName, customerPhone } = resolveSaleWhatsappRecipient(effectiveDraft, clients);
        const saleItems = effectiveDraft?.items?.map((i) => ({ productName: i.productName, quantity: i.quantity })) ?? [];
        const saleTotal = effectiveDraft?.total ?? 0;

        if (!sendWhatsapp) {
          setUndoAction?.(async () => {
            await executeDashboardAction("undo.execute", { target: "sale", count: 1 });
            clearMutationKeysForAction("sale.create");
            await loadBusiness({ silent: true, force: true }).catch(() => {});
            appendChatHistoryEntry("success", t("Sale undone.", "Venta deshecha."));
          });
        } else {
          setUndoAction?.(null);
        }
        if (result.invoice) {
          setFreshInvoiceId?.(result.invoice.id);
        }

        opts.setInput("");

        // Side-effect resolution: WhatsApp send if requested.
        // Skip the attempt entirely when there's no real customer — the
        // server-side phone check would fail anyway, and "El cliente no
        // tiene teléfono" is a misleading message when no customer was
        // identified in the first place.
        let whatsapp: SaleCompletionWhatsapp = { status: "skipped" };
        if (sendWhatsapp) {
          const customerId = effectiveDraft?.customer?.id?.trim() ?? "";
          const customerNameLower = effectiveDraft?.customer?.name?.trim().toLowerCase() ?? "";
          const hasRealCustomer = customerId.length > 0 && customerNameLower !== "consumidor final";

          if (!hasRealCustomer) {
            preOpenedWindow?.close();
            whatsapp = {
              status: "failed",
              reason: t("I couldn't identify who to send the WhatsApp to. Tell me the customer's name.", "No identifiqué a quién enviar el WhatsApp. Decime el nombre del cliente."),
            };
          } else {
            const invoiceForWhatsapp = result.invoice;
            if (invoiceForWhatsapp) {
              const wa = await sendInvoiceToCustomer(
                invoiceForWhatsapp.id,
                invoiceForWhatsapp.invoiceNumber,
                customerPhone,
                invoiceForWhatsapp.payload,
              );

              // A newer sale flow may have started during the send — suppress
              // UI feedback if stale so it doesn't pollute the new flow's chat.
              // Return WITHOUT clearing the shared draft so we don't wipe the
              // newer flow's parsed state. Also skip clearing submitting so the
              // new flow's button is not re-enabled prematurely (double-execute risk).
              if (isStale()) {
                skipClearSubmitting = true;
                return { ok: true, invoiceId: invoiceForWhatsapp.id };
              }

              whatsapp = wa.ok
                ? { status: "sent", message: wa.message }
                : { status: "failed", reason: wa.message };
            } else {
              preOpenedWindow?.close();
              whatsapp = {
                status: "failed",
                reason: t("Could not generate the receipt to send via WhatsApp.", "No se pudo generar el comprobante para enviar por WhatsApp."),
              };
            }
          }
        }

        await loadBusiness({ silent: true, force: true }).catch(() => {});

        // Single dispatch — one toast, one durable bubble — replaces the
        // previous 3-toast / 2-bubble fanout across success/error/invoice
        // notice slots.
        if (!isStale() && result.sale) {
          triggerConfirmFeedback();
          const event: SaleCompletionEvent = {
            saleId: result.sale.id,
            invoiceId: result.invoice?.id ?? null,
            invoiceNumber: result.invoice?.invoiceNumber ?? null,
            customerName,
            items: saleItems,
            total: saleTotal,
            locale,
            currency: opts.currency ?? "ARS",
            whatsapp,
          };
          dispatchSaleCompletion(event, { setInvoiceStatusNotice, notifyChatSuccess });

          if (!sendWhatsapp && result.invoice && getAppSettings().openReceiptAfterSale) {
            downloadInvoicePdf(result.invoice.id, result.invoice.invoiceNumber);
          }

          // Post-sale chip: offer to send the receipt via WhatsApp when:
          //   1. autoSend was not used (wpp not already dispatched).
          //   2. The sale has a real customer (not Consumidor Final).
          //   3. That customer has a phone number on file.
          // The chip value uses the confirm_whatsapp: prefix handled
          // client-side in useAssistantStreaming — no server roundtrip.
          const customerId = effectiveDraft?.customer?.id?.trim() ?? "";
          const customerNameLower = effectiveDraft?.customer?.name?.trim().toLowerCase() ?? "";
          const hasRealCustomer = customerId.length > 0 && customerNameLower !== "consumidor final";
          if (!sendWhatsapp && hasRealCustomer && customerPhone && result.invoice) {
            const invoiceId = result.invoice.id;
            const invoiceNumber = result.invoice.invoiceNumber;
            const wppChips: ChipsBundle = {
              kind: "single",
              options: [
                {
                  label: "📨 Mandar comprobante por WhatsApp",
                  value: `confirm_whatsapp:${invoiceId}:${invoiceNumber}`,
                },
              ],
            };
            appendChatHistoryEntry("reply", "", wppChips);
          }
        }

        // Clear the draft AFTER all side-effects, but only if no newer flow
        // has taken over. If a newer flow opened during our async work, it
        // already owns the parsed state and we must not wipe it.
        if (!isStale()) {
          clearStaleSaleDraftPrompt?.();
          clearSharedSaleDraft();
        }

        return { ok: true, invoiceId: result.invoice?.id ?? null };
      }
      return { ok: false, invoiceId: null };
    } catch (e) {
      // Sale itself failed — different concern from sale-success-with-side-effect-failure.
      // Keep the inline error path: surface to confirmError + transient error bubble.
      if (!isStale()) {
        const errMsg = e instanceof Error ? e.message : t("Could not complete this action.", "No pude completar esta acción.");
        appendChatHistoryEntry("error", errMsg);
        setConfirmError(errMsg);
      }
      return { ok: false, invoiceId: null };
    } finally {
      if (!skipClearSubmitting) {
        opts.setAssistantConfirmationSubmitting(false);
      }
    }
  }

  return {
    sendInvoiceToCustomer,
    runSaleConfirmFlow,
  };
}
