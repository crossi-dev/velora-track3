"use client";

import type { PendingSaleFlow } from "../pendingSaleFlow";
import type { InvoiceStatus } from "../types";
import type {
  SaleOrchestrationActionKey,
  SaleOrchestrationPayload,
  SaleOrchestrationResult,
} from "../actions/contracts";
import type {
  ChatHistoryEntry,
  ChipsBundle,
  AssistantAction,
  AssistantStockDraft,
  AssistantConfirmationRequest,
  CobroQrDraftState,
  ParsedSale,
  FeedbackNotice,
  Product,
  ContactRow,
  CustomerSelectContext,
  PurchaseRequestRecord,
} from "../types";
import { type ParsedAssistantResponse } from "./assistant-chat-utils";
import { actionHandlers, sendPurchaseRequestToSupplier, type ActionContext } from "./action-handlers";
import { tLang } from "../DashboardLangContext";

// ── Options ─────────────────────────────────────────────────────────

export interface UseAssistantActionsOptions {
  businessId: string | null;
  products: Product[];
  clients: ContactRow[];
  manufacturers: ContactRow[];
  latestPurchaseRequest: PurchaseRequestRecord | null;

  // Setters
  setAssistantReply: (msg: string | null) => void;
  setAssistantConfirmationRequest: (req: AssistantConfirmationRequest | null) => void;
  setAssistantStockDraft: (draft: AssistantStockDraft | null) => void;
  setCobroQrDraft: (draft: CobroQrDraftState | null) => void;
  setAssistantInputHint: (hint: string | null) => void;
  setAssistantQuestionContext: (ctx: string | null) => void;
  setCustomerSelectContext: (v: CustomerSelectContext | null) => void;
  setSaleDraftInput: (v: string) => void;
  setActiveTab: (tab: string) => void;
  setActiveInvoiceId: (id: string | null) => void;
  setInvoiceSheetOpen: (open: boolean) => void;
  setInvoiceStatusNotice: (msg: FeedbackNotice | null) => void;
  setPurchaseActionNotice: (msg: string | null) => void;
  setLatestPurchaseRequest: (req: PurchaseRequestRecord | null) => void;

  // Chat history
  appendChatHistoryEntry: (
    kind: ChatHistoryEntry["kind"],
    text: string
  ) => void;
  appendTransientReply: (text: string, agentActivity?: import("../types").AgentActivity[] | null) => void;
  // C3: entryId pins the durable reply to the server replyClientMessageId for P2002 collapse.
  appendDurableReply: (text: string, chips?: ChipsBundle | null, agentActivity?: import("../types").AgentActivity[] | null, entryId?: string, widget?: import("../types").WidgetDescriptor | null) => void;
  notifyChatSuccess?: (msg: string) => void;

  // Domain callbacks
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  updateProduct: (id: string, patch: Partial<Product>) => Promise<void>;
  updateSupplierField: (
    id: string,
    field: string,
    nextValue: string,
    currentValue: string | null | undefined
  ) => Promise<void>;
  updateClientField: (
    id: string,
    field: string,
    nextValue: string,
    currentValue: string | null | undefined
  ) => Promise<void>;
  updateInvoiceStatus: (
    id: string,
    status: InvoiceStatus
  ) => Promise<void>;
  downloadInvoicePdf: (id: string, num: string) => void;
  downloadPurchaseRequestPdf: (id: string, num: string) => void;
  sendInvoiceToCustomer: (
    invoiceId: string,
    invoiceNumber: string,
    selectedCustomerPhone?: string | null
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>;
  callParseSale: (
    text: string,
    hints?: {
      matchedProductId?: string | null;
      matchedCustomerId?: string | null;
    },
    priceOverrides?: Record<string, number>
  ) => Promise<ParsedSale | null>;
  dispatchSaleAction: <K extends SaleOrchestrationActionKey>(
    action: K,
    payload: SaleOrchestrationPayload<K>
  ) => Promise<SaleOrchestrationResult<K>>;
  activatePendingSaleClarification: (flow: PendingSaleFlow) => void;

  t: (en: string, es: string) => string;
}

// ── Hook ────────────────────────────────────────────────────────────

export function useAssistantActions(opts: UseAssistantActionsOptions) {
  const ctx: ActionContext = opts;

  async function executeAction(
    assistantAction: AssistantAction | undefined,
    parsed: ParsedAssistantResponse,
    rawInput: string,
  ): Promise<boolean> {
    if (!assistantAction) return false;

    const handler = actionHandlers[assistantAction.type];
    if (handler) {
      // Cast needed: ActionHandlerArgs.action is typed as Record<string, unknown>
      // (handlers narrow individual fields internally via `action.x as T`). The
      // AssistantAction discriminated union has typed-object variants that TS
      // doesn't assign directly to an index-signature type, so `as unknown as`
      // is the standard escape hatch here. Tightening to the discriminated
      // union requires updating every handler (8 files) to read typed fields
      // via a switch on `action.type`; out of scope for this change.
      return handler({
        action: assistantAction as unknown as Record<string, unknown>,
        parsed,
        rawInput,
        ctx,
      });
    }

    return false;
  }

  function handleFallbackReply(
    parsed: ParsedAssistantResponse,
  ) {
    const {
      assistantAnswer,
      questionContext,
      questionInputHint,
    } = parsed;

    if (questionContext) {
      opts.setAssistantQuestionContext(questionContext);
      opts.setAssistantInputHint(questionInputHint);
    } else {
      // Clear stale question hint from a previous turn so it doesn't bleed
      // into unrelated subsequent turns.
      opts.setAssistantQuestionContext(null);
      opts.setAssistantInputHint(null);
    }

    const reply =
      assistantAnswer ??
      tLang("Sorry, I didn't quite understand. Can you try another way?", "Perdón, no entendí bien. ¿Podés intentar de otra forma?");
    opts.setAssistantReply(reply);
    if (questionContext) {
      opts.appendTransientReply(reply, parsed.agentActivity ?? null);
    } else {
      // Chips ride along on the durable reply so they survive the
      // /api/chat-history persistence cycle and re-hydrate on reload.
      // C3: pass replyClientMessageId so the entry.id matches the server row → P2002 collapse.
      opts.appendDurableReply(reply, parsed.chips ?? null, parsed.agentActivity ?? null, parsed.replyClientMessageId ?? undefined, parsed.widget ?? null);
    }
  }

  return {
    executeAction,
    handleFallbackReply,
    sendPurchaseRequestToSupplier: (
      request = opts.latestPurchaseRequest,
      sendOptions?: { emitChatMessage?: boolean }
    ) => {
      const result = sendPurchaseRequestToSupplier(request, ctx);
      if (sendOptions?.emitChatMessage) {
        result.then((msg) => opts.appendDurableReply(msg));
      }
      return result;
    },
  };
}
