// Helpers extracted from useChatHistory.ts so that file stays under the
// 400-LOC ceiling (CLAUDE.md "Code Size Contract"). Pure functions — no
// React, no state — easy to unit-test in isolation.

import { TRANSIENT_REPLY_PREFIX } from "../chat-history-entry";
import type { ChatHistoryEntry } from "../types";

export const TRANSIENT_ENTRY_ID_PREFIX = "tmp:";

export const OBSOLETE_CHAT_REPLY_TEXTS = new Set([
  "completar precio pendiente descartado.",
  "selección de cliente descartada.",
  "carga de inventario reemplazada por una nueva consulta.",
  "confirmación pendiente descartada.",
  "consulta pendiente descartada.",
  "borrador de venta cancelado.",
  "borrador de venta reemplazado.",
  "acción cancelada.",
  "price prompt dismissed.",
  "customer selection dismissed.",
  "stock load replaced by a new query.",
  "pending confirmation dismissed.",
  "pending question dismissed.",
  "sale draft canceled.",
  "sale draft replaced.",
]);

export const SALE_DRAFT_PROMPT_TEXTS = new Set([
  "venta detectada. revisá el borrador y confirmá.",
  "listo, el borrador de venta está preparado para confirmar.",
]);

// CriticalWriteEvent trace summaries to drop from the chat thread.
// Each entry corresponds to an operation whose confirmation message
// already covers the user (emitted by useAssistantConfirmation /
// useStockDraft / etc.). Without filtering, the trace would render
// alongside the confirmation as a duplicate bubble.
//
// Sales are intentionally NOT here — the canonical-key dedup handles
// them because both sides carry the invoice number.
export const SUPPRESSED_TRACE_PATTERNS: readonly RegExp[] = [
  /^Producto (?:eliminado|archivado)/i,    // delete_product / archived
  /^Producto creado:/i,                     // create_product
  /^Producto actualizado:/i,                // edit_product
  /^Stock actualizado\.?$/i,                // stock_load (bare)
  /^Movimiento de caja registrado:/i,       // register_movement
];

// Canonical key extractor for cross-thread dedup between durable sale
// chat messages and durable action traces. Returns null if the text
// doesn't look like a sale-completion line.
export function extractCanonicalBusinessEventKey(text: string): string | null {
  const normalizedText = text.trim();

  const saleChatMatch = normalizedText.match(/comprobante:\s*([a-z0-9\-/]+(?:\.[a-z0-9\-/]+)*)/i);
  if (saleChatMatch?.[1]) {
    return `sale:${saleChatMatch[1].trim().toLowerCase()}`;
  }

  const saleTraceMatch = normalizedText.match(/^venta registrada\s+[—-]\s*(.+?)\s+[—-]\s*(.+)$/i);
  if (saleTraceMatch?.[1]) {
    return `sale:${saleTraceMatch[1].trim().toLowerCase()}`;
  }

  const legacySaleTraceMatch = normalizedText.match(/^created sale [a-z0-9]{20,} and invoice (.+?) for /i);
  if (legacySaleTraceMatch?.[1]) {
    return `sale:${legacySaleTraceMatch[1].trim().toLowerCase()}`;
  }

  return null;
}

export function isObsoleteChatHistoryEntry(entry: ChatHistoryEntry): boolean {
  if (entry.kind !== "reply") return false;
  const normalized = entry.text.trim().toLowerCase();
  if (normalized.startsWith(TRANSIENT_REPLY_PREFIX)) return false;
  return OBSOLETE_CHAT_REPLY_TEXTS.has(normalized);
}

export function shouldSkipLocalBusinessHistoryEntry(
  kind: ChatHistoryEntry["kind"],
  text: string
): boolean {
  if (kind !== "reply") return false;

  const normalizedInput = text.trim();
  if (normalizedInput.startsWith(TRANSIENT_REPLY_PREFIX)) {
    return false;
  }

  const normalized = normalizedInput.toLowerCase();
  const looksLikeBusinessResultReply =
    /(venta|factura|inventario|stock|producto|cliente|proveedor|solicitud|movimiento|acción|accion|cuit)/.test(normalized) &&
    /(confirmad|guardad|registrad|actualizad|eliminad|cread|enviad|descartad|reemplazad|marcad|deshech)/.test(normalized);

  return (
    normalized === "borrador de venta cancelado." ||
    normalized === "borrador de venta reemplazado." ||
    normalized === "acción cancelada." ||
    looksLikeBusinessResultReply
  );
}

export function isStaleSaleDraftPrompt(entry: ChatHistoryEntry): boolean {
  return entry.kind === "reply" && SALE_DRAFT_PROMPT_TEXTS.has(entry.text.trim().toLowerCase());
}
