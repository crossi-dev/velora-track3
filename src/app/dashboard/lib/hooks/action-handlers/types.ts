import type {
  ChatHistoryEntry,
  ChipsBundle,
  AssistantStockDraft,
  AssistantConfirmationRequest,
  CobroQrDraftState,
  Product,
  ContactRow,
  FeedbackNotice,
  PurchaseRequestRecord,
} from "../../types";
import type { ParsedAssistantResponse } from "../assistant-chat-utils";
import type {
  SaleOrchestrationActionKey,
  SaleOrchestrationPayload,
  SaleOrchestrationResult,
} from "../../actions/contracts";
import type { ParsedSale, InvoiceStatus } from "../../types";
import type { PendingSaleFlow } from "../../pendingSaleFlow";

export interface ActionContext {
  businessId: string | null;
  products: Product[];
  clients: ContactRow[];
  manufacturers: ContactRow[];
  latestPurchaseRequest: PurchaseRequestRecord | null;

  setAssistantReply: (msg: string | null) => void;
  setAssistantConfirmationRequest: (req: AssistantConfirmationRequest | null) => void;
  setAssistantStockDraft: (draft: AssistantStockDraft | null) => void;
  setCobroQrDraft: (draft: CobroQrDraftState | null) => void;
  setAssistantInputHint: (hint: string | null) => void;
  setCustomerSelectContext: (v: { saleText: string; clients: Array<{ id: string; name: string }> } | null) => void;
  setSaleDraftInput: (v: string) => void;
  setActiveTab: (tab: string) => void;
  setActiveInvoiceId: (id: string | null) => void;
  setInvoiceSheetOpen: (open: boolean) => void;
  setInvoiceStatusNotice: (msg: FeedbackNotice | null) => void;
  setPurchaseActionNotice: (msg: string | null) => void;
  setLatestPurchaseRequest: (req: PurchaseRequestRecord | null) => void;

  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string, chips?: ChipsBundle | null) => void;
  appendTransientReply: (text: string) => void;
  appendDurableReply: (text: string, chips?: ChipsBundle | null) => void;
  notifyChatSuccess?: (msg: string) => void;

  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  updateProduct: (id: string, patch: Partial<Product>) => Promise<void>;
  updateSupplierField: (id: string, field: string, nextValue: string, currentValue: string | null | undefined) => Promise<void>;
  updateClientField: (id: string, field: string, nextValue: string, currentValue: string | null | undefined) => Promise<void>;
  updateInvoiceStatus: (id: string, status: InvoiceStatus) => Promise<void>;
  downloadInvoicePdf: (id: string, num: string) => void;
  downloadPurchaseRequestPdf: (id: string, num: string) => void;
  sendInvoiceToCustomer: (invoiceId: string, invoiceNumber: string, selectedCustomerPhone?: string | null) => Promise<{ ok: true; message: string } | { ok: false; message: string }>;
  callParseSale: (text: string, hints?: { matchedProductId?: string | null; matchedCustomerId?: string | null }, priceOverrides?: Record<string, number>) => Promise<ParsedSale | null>;
  dispatchSaleAction: <K extends SaleOrchestrationActionKey>(action: K, payload: SaleOrchestrationPayload<K>) => Promise<SaleOrchestrationResult<K>>;
  activatePendingSaleClarification: (flow: PendingSaleFlow) => void;

  t: (en: string, es: string) => string;
}

export interface ActionHandlerArgs {
  action: Record<string, unknown>;
  parsed: ParsedAssistantResponse;
  rawInput: string;
  ctx: ActionContext;
}

export type ActionHandler = (args: ActionHandlerArgs) => Promise<boolean>;
