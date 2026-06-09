// Aggregator detectors para el NLU facade — separan la *detección* de
// la *ejecución* en handlers/invoices.ts y handlers/purchase-requests.ts.
//
// Los handlers ya exportan sub-detectores granulares (lookup / download /
// whatsapp / status). Este módulo solo los compone en `looksLike*Command`
// para que `nlu/detect.ts` pueda devolver el discriminated union sin
// importar la lógica de ejecución.

import {
  looksLikeInvoiceLookupRequest,
  looksLikeInvoiceDownloadRequest,
  looksLikeInvoiceWhatsappRequest,
  looksLikeInvoiceStatusRequest,
} from "../handlers/invoices";
import {
  looksLikePurchaseRequestLookupRequest,
  looksLikePurchaseRequestDownloadRequest,
  looksLikePurchaseRequestWhatsappRequest,
} from "../handlers/purchase-requests";

export function looksLikeInvoiceCommand(text: string): boolean {
  return (
    looksLikeInvoiceLookupRequest(text) ||
    looksLikeInvoiceDownloadRequest(text) ||
    looksLikeInvoiceWhatsappRequest(text) ||
    looksLikeInvoiceStatusRequest(text)
  );
}

export function looksLikePurchaseRequestCommand(text: string): boolean {
  return (
    looksLikePurchaseRequestLookupRequest(text) ||
    looksLikePurchaseRequestDownloadRequest(text) ||
    looksLikePurchaseRequestWhatsappRequest(text)
  );
}
