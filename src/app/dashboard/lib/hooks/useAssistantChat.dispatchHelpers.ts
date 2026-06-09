"use client";

import type {
  AssistantConfirmationRequest,
  AssistantStockDraft,
  ChatHistoryEntry,
  ChipsBundle,
  ContactRow,
  InvoiceRecord,
  Product,
  SaleRecord,
} from "../types";
import type {
  SaleOrchestrationActionKey,
  SaleOrchestrationPayload,
  SaleOrchestrationResult,
} from "../actions/contracts";

/**
 * Shared context passed into every Command-Layer dispatch handler. The host
 * hook owns all React state; this interface is the read/write contract each
 * handler receives. Inlined from the former dispatch-context.ts (which was a
 * 24-line pure-interface file with no logic — collapsed here 2026-05-16).
 */
export interface CommandLayerDispatchContext {
  products: Product[];
  clients: ContactRow[];
  sales: SaleRecord[];
  invoices: InvoiceRecord[];
  currentCash: number;
  businessCurrency: string;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string, chips?: ChipsBundle | null) => void;
  appendDurableReply: (text: string, chips?: ChipsBundle | null) => void;
  appendTransientReply: (text: string) => void;
  setInput: (v: string) => void;
  setAssistantReply: (msg: string | null) => void;
  setAssistantStockDraft: (draft: AssistantStockDraft | null) => void;
  setAssistantConfirmationRequest: (req: AssistantConfirmationRequest | null) => void;
  setLoadingParse: (v: boolean) => void;
  updateProduct: (id: string, patch: Partial<Product>) => Promise<void>;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  dispatchSaleAction: <K extends SaleOrchestrationActionKey>(action: K, payload: SaleOrchestrationPayload<K>) => Promise<SaleOrchestrationResult<K>>;
}

// Pure-text Command-Layer replies (check_stock, inventory_list, etc.)
// resolve synchronously in the browser. Without a small artificial delay
// the answer appears before the eye can register it, which reads as
// broken. 400ms matches the typical AI round-trip floor so both paths
// feel the same to the user.
export const COMMAND_LAYER_THINK_DELAY_MS = 400;

/**
 * Looks up a live Product in ctx.products by ID. Returns null when the
 * parser couldn't resolve the name against the catalog (productId is
 * null) OR when the ID is stale (product no longer in the current
 * catalog snapshot). Write-intent handlers call this and `return false`
 * on null so handleGo falls through to the AI path silently — the AI
 * handles ambiguous / misheard product names better than a local "no
 * encontré" error message.
 */
export function resolveLiveProduct(
  ctx: CommandLayerDispatchContext,
  productId: string | null,
): Product | null {
  if (!productId) return null;
  return ctx.products.find((p) => p.id === productId) ?? null;
}

export function makeConfirmationId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `c_${Date.now()}`;
}

/**
 * Shared boilerplate for pure-text-reply handlers: echo user text,
 * clear input, show the ThinkingIndicator for
 * COMMAND_LAYER_THINK_DELAY_MS, then emit the reply (durable + visible).
 */
export async function emitTextReply(
  ctx: CommandLayerDispatchContext,
  rawTextForParser: string,
  compute: () => string,
): Promise<true> {
  ctx.appendChatHistoryEntry("user", rawTextForParser);
  ctx.setInput("");
  ctx.setLoadingParse(true);
  try {
    await new Promise((r) => setTimeout(r, COMMAND_LAYER_THINK_DELAY_MS));
    const reply = compute();
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    return true;
  } finally {
    ctx.setLoadingParse(false);
  }
}

/**
 * Shared boilerplate for confirmation-card write-intent handlers: echo
 * user text, clear input, show the think delay, then emit the card +
 * visible reply.
 */
export async function emitConfirmationCard(
  ctx: CommandLayerDispatchContext,
  rawTextForParser: string,
  request: AssistantConfirmationRequest,
): Promise<true> {
  ctx.appendChatHistoryEntry("user", rawTextForParser);
  ctx.setInput("");
  ctx.setLoadingParse(true);
  try {
    await new Promise((r) => setTimeout(r, COMMAND_LAYER_THINK_DELAY_MS));
    ctx.setAssistantReply(request.message);
    ctx.appendTransientReply(request.message);
    ctx.setAssistantConfirmationRequest(request);
    return true;
  } finally {
    ctx.setLoadingParse(false);
  }
}
