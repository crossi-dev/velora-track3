import { tLang } from "./DashboardLangContext";
import { normalizeLookupText } from "./helpers";
import type { ContactRow, ParsedSale } from "./types";

export function resolveSaleWhatsappRecipient(
  parsed: ParsedSale | null,
  clients: ContactRow[]
) {
  const customerName = parsed?.customer?.name?.trim() || tLang("Final Consumer", "Consumidor Final");
  let customerPhone: string | null = null;
  if (parsed?.customer?.id) {
    customerPhone = clients.find((c) => c.id === parsed.customer.id)?.phone?.trim() ?? null;
  }
  if (!customerPhone && parsed?.customer?.name) {
    const needle = normalizeLookupText(parsed.customer.name);
    const nameMatch = clients.find((c) => normalizeLookupText(c.name) === needle);
    customerPhone = nameMatch?.phone?.trim() ?? null;
  }

  return {
    customerName,
    customerPhone,
  };
}
