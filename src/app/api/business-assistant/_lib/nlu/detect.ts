// NLU facade — un único punto de entrada para detección determinística
// de intent a partir del texto crudo del usuario.
//
// Priority order is a DATA CONTRACT (declarative table), not positional
// accident. Each entry: { label, guard?, detect }. First hit wins.
// Order is 1:1 with the previous if-chain — behavior-preserving refactor.
//
// Complex wrappers (sale_send, sale_create) live in detect-wrappers.ts;
// all other detector calls are inline in the table below (keeping them
// visible in this file so INV-4 counts them correctly).

import { looksLikeUndoRequest } from "../confirmation";
import { looksLikeSaleWithForgottenCustomer } from "../handlers/forgot-customer";
// looksLikeCreateCustomerRequest, detectCreateProductFastPath, detectStockLoadFastPath,
// detectMultiProductPriceEditFull: imported by other modules; kept out of detect.ts
// PRIORITY_TABLE (labels 3/3a/3b/7 removed 2026-05-30 — OA Phase 4 cleanup).
import { detectBusinessSetupFastPath } from "./business-setup-fast-path";
import { detectStockQueryFastPath, detectStockSummaryFastPath } from "./stock-query-fast-path";
import { detectPriceQueryFastPath } from "./price-query-fast-path";
import { detectDeleteProductFastPath } from "./delete-product-fast-path";
import { looksLikePriceUpdateIntent, looksLikeSinglePriceEditIntent } from "../handlers/price-intent-detector";
import { detectOwnerOnlyIntent, looksLikeDeleteSaleItem } from "../handlers/owner-only-detectors";
import { looksLikeCobroQrIntent } from "../handlers/cobro-qr-intent";
import { looksLikeInvoiceCommand, looksLikePurchaseRequestCommand } from "./command-detectors";
import { looksLikeInvoiceSendRequest } from "../handlers/invoices";
import { detectExternalAgentIntent } from "./external-agent-fast-path";
import { detectAndreaniIntent } from "./andreani-fast-path";
import { detectCredentialUpdateIntent } from "./credential-update-intent";
import {
  detectPaymentLinkFastPath,
  detectPaymentLinkSend,
  detectPaymentLinkCancel,
} from "./payment-link-fast-path";
import { detectBusinessPostalReply } from "./business-postal-reply-fast-path";
import { normalizeForMatching, normalizeArMoneySlang } from "../shared";
import { normalizeStockWordNumbers } from "./word-numbers";
import { detectSaleSendFastPath, detectSaleCreateComposite } from "./detect-wrappers";
import type { DeterministicIntent } from "./types";
export { DETERMINISTIC_HINT_RE, mightBeDeterministicIntent } from "./hint-precheck";

export interface NluContext {
  catalog: {
    products: Array<{ id: string; name: string }>;
    customers: Array<{ id: string; name: string }>;
  };
  productInfoDirectory: Array<{ name: string }>;
  invoiceDirectory: Array<{ id: string; number?: string | null }>;
  purchaseRequestDirectory: Array<{ id: string }>;
  actorRole?: "owner" | "employee";
  /** Recent conversation turns. Used by context-gated detectors (e.g. business_postal_reply). */
  recentHistory?: Array<{ role: "user" | "assistant"; text: string }>;
}

interface TableEntry {
  label: string;
  guard?: (ctx: NluContext) => boolean;
  detect: (text: string, ctx: NluContext) => DeterministicIntent | null;
}

// Declarative priority table — first match wins. Order = old if-chain order, 1:1.
const PRIORITY_TABLE: TableEntry[] = [
  // Payment link send/cancel chip-tap — owner-only exact machine tokens.
  // MUST come first (before undo, delete-sale-item, owner-only-blocked) because
  // "cancelar_link_pago" contains "cancelar" which the undo detector also matches.
  { label: "0-pl-send", guard: (c) => c.actorRole === "owner",
    detect: (t) => { const r = detectPaymentLinkSend(t); return r ?? null; } },
  { label: "0-pl-cancel", guard: (c) => c.actorRole === "owner",
    detect: (t) => { const r = detectPaymentLinkCancel(t); return r ?? null; } },
  // business_postal_reply — owner replies with a postal code after Velora asked.
  // Context-gated: fires ONLY when the last assistant turn contains the marker phrase.
  // Must come before label "1" (undo) so a bare number is not misrouted.
  // Safe to place early: the history marker makes false-positive rate negligible.
  { label: "0-postal-reply", guard: (c) => c.actorRole === "owner",
    detect: (t, c) => { const r = detectBusinessPostalReply(t, c.recentHistory ?? []); return r ?? null; } },
  { label: "0a", guard: (c) => !!c.actorRole && c.actorRole !== "owner",
    detect: (t) => looksLikeDeleteSaleItem(t) ? { kind: "delete_sale_item_escalation", rawText: t } : null },
  { label: "0", guard: (c) => !!c.actorRole && c.actorRole !== "owner",
    detect: (t, c) => { const b = detectOwnerOnlyIntent(t, c.catalog); return b ? { kind: "owner_only_blocked", blockedIntent: b } : null; } },
  { label: "1",
    detect: (t) => { const r = looksLikeUndoRequest(t); return r ? { kind: "undo", target: r.target, count: r.count } : null; } },
  { label: "2",
    detect: (t, c) => looksLikeSaleWithForgottenCustomer(t) && c.catalog.customers.length > 0 ? { kind: "forgot_customer", saleText: t } : null },
  // Labels 3 (create_customer), 3a (stock_load_fast_path), 3b (create_product) removed
  // 2026-05-30 (OA Phase 4 cleanup). OA now owns these intents (USE_OWNER_ASSISTANT=true).
  // The detect functions remain exported for tests; routing is removed.
  { label: "3c",
    detect: (t) => { const r = detectBusinessSetupFastPath(t); return r ? { kind: "business_setup_fast_path", field: r.field, value: r.value, label: r.label } : null; } },
  { label: "3d",
    detect: (t, c) => { const r = detectDeleteProductFastPath(t, c.catalog.products); return r ? { kind: "delete_product", productText: r.productText } : null; } },
  { label: "3f",
    detect: (t) => looksLikeInvoiceSendRequest(t) && normalizeForMatching(t).includes("factura") ? { kind: "invoice" } : null },
  // Payment link fast path — owner-only. Must come BEFORE sale_send (label "4")
  // so "cobrale X por wpp" reaches the Payments Agent deterministically instead
  // of registering a direct sale. Also handles "link de pago/cobro" and
  // verb+"link" patterns. See root-cause analysis 2026-05-18 + 2026-05-21.
  { label: "3z", guard: (c) => c.actorRole === "owner",
    detect: (t) => { const r = detectPaymentLinkFastPath(t); return r ?? null; } },
  { label: "4",
    detect: (t, c) => detectSaleSendFastPath(t, c) },
  { label: "4b",
    detect: (t, c) => detectSaleCreateComposite(t, c) },
  { label: "5",
    detect: (t, c) => { const r = looksLikeCobroQrIntent(t, c.catalog.customers); return r ? { kind: "cobro_qr", metodo: r.metodo, monto: r.monto, matchedCustomerId: r.matchedCustomerId, customerName: r.customerName } : null; } },
  { label: "6", guard: (c) => c.actorRole !== "owner",
    detect: (t) => looksLikeSinglePriceEditIntent(t) ? { kind: "single_price_edit" } : null },
  // Label 7 (multi_price_edit) removed 2026-05-30 (OA Phase 4 cleanup).
  // OA now owns bulk_price_update (USE_OWNER_ASSISTANT=true).
  { label: "8",
    detect: (t) => looksLikePriceUpdateIntent(t) ? { kind: "price_update_clarification" } : null },
  // Logística antes del bloque de price/stock query: detectAndreaniIntent exige
  // verbo de cotización + sustantivo de envío, así que es más específico que
  // price_query ("cuánto sale X"). Sin esto, "cuánto sale enviar a CP X" lo
  // agarra price_query y nunca llega al agente de Logística.
  { label: "8a", guard: (c) => c.actorRole === "owner",
    detect: (t) => detectAndreaniIntent(t) },
  { label: "8b1",
    detect: (t) => detectStockSummaryFastPath(t) ? { kind: "stock_summary" } : null },
  { label: "8b2", guard: (c) => c.productInfoDirectory.length > 0,
    detect: (t) => { const r = detectStockQueryFastPath(t); return r ? { kind: "stock_query", productText: r.productText } : null; } },
  { label: "8c", guard: (c) => c.productInfoDirectory.length > 0,
    detect: (t) => { const r = detectPriceQueryFastPath(t); return r ? { kind: "price_query", queryKind: r.queryKind, productText: r.productText } : null; } },
  { label: "9",
    detect: (t) => looksLikeInvoiceCommand(t) || looksLikeInvoiceSendRequest(t) ? { kind: "invoice" } : null },
  { label: "10", guard: (c) => c.purchaseRequestDirectory.length > 0,
    detect: (t) => looksLikePurchaseRequestCommand(t) ? { kind: "purchase_request" } : null },
  { label: "11", guard: (c) => c.actorRole === "owner",
    detect: (t) => { const r = detectExternalAgentIntent(t); return r ? { kind: "external_agent_call", peerHint: r.peerHint, skillId: r.skillId, productText: r.productText, qty: r.qty } : null; } },
  // Credential-update intents — post-onboarding config changes via chat.
  // Owner-only. Must come AFTER all sale/stock/invoice intents (labels 3-11)
  // so domain operations are never mis-routed as credential changes.
  { label: "13", guard: (c) => c.actorRole === "owner",
    detect: (t) => detectCredentialUpdateIntent(t) },
];

export function detectDeterministicIntent(
  text: string,
  ctx: NluContext,
): DeterministicIntent | null {
  if (!text || text.trim().length === 0) return null;
  // Normalize AR money slang BEFORE any detector runs so downstream
  // regex don't need to handle "lucas"/"gambas"/"mangos"/"palos".
  text = normalizeArMoneySlang(text);
  // Normalize Spanish word-numbers to digits so the stock-load fast-path
  // pre-check (/\d/.test) doesn't bail on phrases like "seis unidades".
  // Applied after money-slang so there is no overlap ("mil mangos" is already "1000").
  text = normalizeStockWordNumbers(text);
  for (const entry of PRIORITY_TABLE) {
    if (entry.guard && !entry.guard(ctx)) continue;
    const result = entry.detect(text, ctx);
    if (result !== null) return result;
  }
  return null;
}
