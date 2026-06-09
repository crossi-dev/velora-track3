import type { FeedbackNotice } from "./types";
import { buildSaleConfirmChatMessage } from "./sale-confirm-chat";
import { tLang } from "./DashboardLangContext";

// One sale completion = one event = one toast + one durable bubble.
// Composed at the end of useSaleDraftExecution.runSaleConfirmFlow AFTER the
// sale has been written and the optional WhatsApp side-effect has resolved.
// Replaces the previous pattern of three competing toast slots
// (successNotice / errorNotice / invoiceStatusNotice) plus an in-place
// transient error bubble inside sendInvoiceToCustomer.

export type SaleCompletionWhatsapp =
  | { status: "skipped" }
  | { status: "sent"; message: string }
  | { status: "failed"; reason: string };

export interface SaleCompletionEvent {
  saleId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;

  customerName: string;
  items: Array<{ productName: string; quantity: number }>;
  total: number;
  locale: string;
  currency: string;

  whatsapp: SaleCompletionWhatsapp;
}

export function composeToast(event: SaleCompletionEvent): FeedbackNotice {
  if (event.whatsapp.status === "sent") {
    return { tone: "success", message: tLang("Sale registered and sent via WhatsApp.", "Venta registrada y enviada por WhatsApp.") };
  }
  if (event.whatsapp.status === "failed") {
    return {
      tone: "warning",
      message: tLang(`Sale registered. WhatsApp failed: ${event.whatsapp.reason}`, `Venta registrada. No se pudo enviar por WhatsApp: ${event.whatsapp.reason}`),
    };
  }
  return { tone: "success", message: tLang("Sale registered.", "Venta registrada.") };
}

export interface SaleCompletionDispatchDeps {
  setInvoiceStatusNotice: (notice: FeedbackNotice | null) => void;
  notifyChatSuccess?: (msg: string) => void;
}

export function dispatchSaleCompletion(
  event: SaleCompletionEvent,
  deps: SaleCompletionDispatchDeps,
): void {
  const whatsappForBubble =
    event.whatsapp.status === "sent"
      ? { ok: true, message: event.whatsapp.message }
      : event.whatsapp.status === "failed"
        ? { ok: false, message: event.whatsapp.reason }
        : null;

  const bubble = buildSaleConfirmChatMessage({
    customerName: event.customerName,
    invoiceNumber: event.invoiceNumber,
    whatsappResult: whatsappForBubble,
    items: event.items,
    total: event.total,
    locale: event.locale,
    currency: event.currency,
  });

  deps.setInvoiceStatusNotice(composeToast(event));
  deps.notifyChatSuccess?.(bubble);
}
