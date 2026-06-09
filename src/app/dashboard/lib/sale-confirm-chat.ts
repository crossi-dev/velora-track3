import { tLang } from "./DashboardLangContext";

interface SaleChatWhatsappResult {
  ok: boolean;
  message: string;
}

interface ShouldLoadBusinessAfterSaleConfirmInput {
  sendWhatsapp: boolean;
  hasInvoice: boolean;
  whatsappOk?: boolean | null;
}

interface SaleItem {
  productName: string;
  quantity: number;
}

interface BuildSaleConfirmChatMessageInput {
  customerName?: string | null;
  invoiceNumber?: string | null;
  whatsappResult?: SaleChatWhatsappResult | null;
  items?: SaleItem[] | null;
  total?: number | null;
  locale?: string | null;
  currency?: string | null;
}

export function getSaleDocumentLabel(invoiceNumber?: string | null) {
  const normalized = invoiceNumber?.trim().toUpperCase() ?? "";
  if (normalized.startsWith("FC-")) return tLang("Invoice", "Factura");
  return tLang("Receipt", "Comprobante");
}

export function shouldLoadBusinessAfterSaleConfirm(input: ShouldLoadBusinessAfterSaleConfirmInput) {
  if (!input.sendWhatsapp) return true;
  if (!input.hasInvoice) return true;
  return !input.whatsappOk;
}

export function buildSaleConfirmChatMessage(input: BuildSaleConfirmChatMessageInput) {
  const customerName = input.customerName?.trim() || tLang("Final Consumer", "Consumidor Final");

  const itemsSummary =
    input.items && input.items.length > 0
      ? input.items.map((i) => {
          let name = i.productName;
          // Singularize when quantity is 1: drop trailing "s" for simple Spanish plurals
          if (i.quantity === 1 && name.length > 2 && name.endsWith("s") && !/[sxz]es$/i.test(name)) {
            name = name.slice(0, -1);
          }
          return `${i.quantity} ${name}`;
        }).join(", ")
      : null;

  const totalFormatted =
    input.total != null
      ? new Intl.NumberFormat(input.locale ?? "es-AR", {
          style: "currency",
          currency: input.currency ?? "ARS",
        }).format(input.total)
      : null;

  let body = tLang(`Sale to ${customerName}`, `Venta a ${customerName}`);
  if (itemsSummary) body += `: ${itemsSummary}`;
  if (totalFormatted) body += ` — ${totalFormatted}`;
  body += ".";

  if (input.invoiceNumber?.trim()) {
    const invoice = input.invoiceNumber.trim();
    const label = getSaleDocumentLabel(invoice);
    if (input.whatsappResult?.ok) {
      body += ` ${label} ${invoice} ${tLang("sent via WhatsApp.", "enviado por WhatsApp.")}`;
    } else if (input.whatsappResult && !input.whatsappResult.ok) {
      body += ` ${label}: ${invoice}. ${tLang(`Could not send via WhatsApp: ${input.whatsappResult.message}`, `No se pudo enviar por WhatsApp: ${input.whatsappResult.message}`)}`;
    } else {
      body += ` ${label}: ${invoice}.`;
    }
  } else if (input.whatsappResult?.ok && input.whatsappResult.message.trim()) {
    body += ` ${input.whatsappResult.message.trim()}`;
  }

  return body;
}
