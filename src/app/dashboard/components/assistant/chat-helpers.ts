import type React from "react";
import { buildSaleConfirmChatMessage } from "../../lib/sale-confirm-chat";

export function formatTraceText(text: string): string {
  const saleMatch = text.match(/^Created sale [a-z0-9]{20,} and invoice (.+?) for (.+)$/i);
  if (saleMatch) {
    return buildSaleConfirmChatMessage({ customerName: saleMatch[2], invoiceNumber: saleMatch[1] });
  }

  if (text.toLowerCase().startsWith("venta registrada ")) {
    const remainder = text.slice("Venta registrada ".length).trim();
    const separators = [" - ", " — ", " – "];
    for (const separator of separators) {
      const index = remainder.lastIndexOf(separator);
      if (index > 0) {
        const invoiceNumber = remainder.slice(0, index).trim().replace(/^rec\s*-\s*/i, "").replace(/^rec\s+/i, "").replace(/^[—–-]\s*/, "").trim();
        const customerName = remainder.slice(index + separator.length).trim();
        if (invoiceNumber && customerName) {
          return buildSaleConfirmChatMessage({ customerName, invoiceNumber });
        }
      }
    }
  }

  const requestSummaryMatch = text.match(/^Solicitud de compra creada\s+[—-]\s*(.+?)\s+[—-]\s*(.+)$/i);
  if (requestSummaryMatch) return `Listo, dejé creada la solicitud ${requestSummaryMatch[1]} para ${requestSummaryMatch[2]}.`;
  const stockLoadMatch = text.match(/^Carga de stock de\s+(\d+)\s+(.+)$/i);
  if (stockLoadMatch) return `Listo, sumé ${stockLoadMatch[1]} unidades de ${stockLoadMatch[2]} al stock.`;
  const clientUpdatedMatch = text.match(/^Cliente actualizado\.\s*(.+)$/i);
  if (clientUpdatedMatch) return `Listo, actualicé el cliente.\n${clientUpdatedMatch[1]}`;
  const supplierUpdatedMatch = text.match(/^Proveedor actualizado\.\s*(.+)$/i);
  if (supplierUpdatedMatch) return `Listo, actualicé el proveedor.\n${supplierUpdatedMatch[1]}`;
  const clientDeletedMatch = text.match(/^Cliente "(.+)" eliminado\.$/i);
  if (clientDeletedMatch) return `Listo, eliminé el cliente "${clientDeletedMatch[1]}".`;
  const supplierDeletedMatch = text.match(/^Proveedor "(.+)" eliminado\.$/i);
  if (supplierDeletedMatch) return `Listo, eliminé el proveedor "${supplierDeletedMatch[1]}".`;
  const cuitSavedMatch = text.match(/^CUIT guardado\.$/i);
  if (cuitSavedMatch) return "Listo, guardé el CUIT.";
  const invoiceSentMatch = text.match(/^Factura enviada\.\s*(.+)$/i);
  if (invoiceSentMatch) return `Listo, marqué la factura como enviada.\n${invoiceSentMatch[1]}`;
  const invoicePaidMatch = text.match(/^Factura cobrada\.\s*(.+)$/i);
  if (invoicePaidMatch) return `Listo, marqué la factura como cobrada.\n${invoicePaidMatch[1]}`;
  const stockUpdatedMatch = text.match(/^Stock actualizado\.\s*(.+)$/i);
  if (stockUpdatedMatch) return `Listo, actualicé el stock.\n${stockUpdatedMatch[1]}`;
  const productAddedMatch = text.match(/^Producto agregado\.$/i);
  if (productAddedMatch) return "Listo, agregué el producto.";
  const clientAddedMatch = text.match(/^Cliente agregado\.$/i);
  if (clientAddedMatch) return "Listo, agregué el cliente.";
  const supplierAddedMatch = text.match(/^Proveedor agregado\.$/i);
  if (supplierAddedMatch) return "Listo, agregué el proveedor.";
  const movementRegisteredMatch = text.match(/^Movimiento registrado\.$/i);
  if (movementRegisteredMatch) return "Listo, registré el movimiento.";
  const saleRegisteredMatch = text.match(/^Venta registrada\.$/i);
  if (saleRegisteredMatch) return "Listo, registré la venta.";
  const saleRecordedMatch = text.match(/^Sale recorded\.$/i);
  if (saleRecordedMatch) return "Listo, registré la venta.";
  const stockUpdatedBareMatch = text.match(/^Stock actualizado\.$/i);
  if (stockUpdatedBareMatch) return "Listo, actualicé el stock.";
  const cashMovementMatch = text.match(/^Movimiento de caja registrado:\s*(.+)$/i);
  if (cashMovementMatch) return `Listo, registré el movimiento de caja: ${cashMovementMatch[1]}.`;
  const productCreatedMatch = text.match(/^Producto creado:\s*(.+)$/i);
  if (productCreatedMatch) return `Listo, agregué el producto ${productCreatedMatch[1]}.`;
  const productUpdatedMatch = text.match(/^Producto actualizado:\s*(.+)$/i);
  if (productUpdatedMatch) return `Listo, actualicé el producto ${productUpdatedMatch[1]}.`;
  const productDeletedMatch = text.match(/^Producto eliminado:\s*(.+)$/i);
  if (productDeletedMatch) return `Listo, eliminé el producto ${productDeletedMatch[1]}.`;
  return text;
}

export function formatTimestamp(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const SUGGEST_RE = /^"([^"]{4,80})"$/m;

export function extractSuggestion(text: string): string | null {
  const m = SUGGEST_RE.exec(text);
  return m ? m[1] : null;
}

// Chat bubble text — canonical 2026 per Facebook Messenger + iOS Messages CSS
// (ishadeed.com/article/facebook-messenger-chat-component + samuelkraft.com/blog/ios-chat-bubbles-css):
// - whiteSpace: pre-wrap → preserve newlines but wrap soft-breaks
// - overflowWrap: break-word → break ONLY when a word would otherwise overflow
//   (NOT word-break: break-word which is more aggressive and splits short words
//   even when they'd fit on a new line — MDN explicit warning).
// - lineHeight: 1.55 ≥ 1.5 per typography standards
// Refs:
//   developer.mozilla.org/.../overflow-wrap
//   developer.mozilla.org/.../word-break (the anti-pattern)
export const BUBBLE_TEXT_BASE: React.CSSProperties = {
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
};

export function formatTimeAgo(ts?: number): string {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "justo ahora";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ayer";
  return `hace ${days}d`;
}
