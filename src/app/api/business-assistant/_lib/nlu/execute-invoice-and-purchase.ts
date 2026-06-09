// Executors para invoice / purchase_request kinds del discriminated union.
// Extraído de dispatch.ts para mantener el dispatcher dentro del límite de
// tamaño (300 líneas por contrato — ver scripts/check-file-size.mjs).
//
// El handler subyacente (handleInvoiceDeterministicRequest /
// handlePurchaseRequestDeterministicRequest) ya hace su propia detección
// fina + resolución de referencia + ejecución. Acá solo invocamos y
// envolvemos en NextResponse, con un fallback defensivo si por alguna
// razón el handler retorna null (no debería dado que el NLU facade ya
// matcheó el comando).

import { NextResponse } from "next/server";
import { handleInvoiceDeterministicRequest } from "../handlers/invoices";
import { handlePurchaseRequestDeterministicRequest } from "../handlers/purchase-requests";
import type { PreModelIntentParams } from "../router-params";

export function executeInvoice(params: PreModelIntentParams): NextResponse {
  const response = handleInvoiceDeterministicRequest({
    text: params.text,
    invoices: params.invoiceDirectory,
    activeInvoiceId: params.activeInvoiceId,
  });
  if (response) return NextResponse.json(response);

  // The handler returned null — the subcommand wasn't recognized (e.g.
  // "enviá la factura al cliente Godot" without a WA/email keyword, or a
  // send-to-customer request with no matching invoices). Return a graceful
  // message that acknowledges the invoice intent and the customer if present,
  // rather than the confusing "¿qué producto querés vender?" LLM fallback.
  // This is the ARCA-deferred honest reply for INV-03 style requests.
  const customerMatch = params.text.match(/\bcliente\s+([A-Za-záéíóúñÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ ]{1,30})/i);
  const customerHint = customerMatch?.[1]?.trim();
  if (customerHint) {
    return NextResponse.json({
      answer: `No encontré facturas emitidas para ${customerHint}. La facturación electrónica está siendo configurada — por ahora podés enviar el comprobante de venta por WhatsApp.`,
    });
  }
  return NextResponse.json({
    answer:
      "No encontré facturas emitidas todavía. La facturación electrónica (ARCA) está siendo configurada. " +
      "Por ahora podés enviar el comprobante de venta por WhatsApp.",
  });
}

export function executePurchaseRequest(params: PreModelIntentParams): NextResponse {
  const response = handlePurchaseRequestDeterministicRequest({
    text: params.text,
    requests: params.purchaseRequestDirectory,
    latestPurchaseRequestId: params.latestPurchaseRequestId,
  });
  if (response) return NextResponse.json(response);
  return NextResponse.json({
    answer: "No pude resolver el comando de solicitud de compra.",
  });
}
