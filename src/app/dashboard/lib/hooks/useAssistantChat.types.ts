import type { PendingSaleFlow } from "../pendingSaleFlow";
import type {
  SaleOrchestrationActionKey,
  SaleOrchestrationPayload,
  SaleOrchestrationResult,
} from "../actions/contracts";
import type {
  ChatHistoryEntry,
  ChipsBundle,
  AssistantConfirmationRequest,
  AssistantStockDraft,
  CobroQrDraftState,
  ParsedSale,
  FeedbackNotice,
  MissingFieldHint,
  Product,
  ContactRow,
  InvoiceRecord,
  SaleRecord,
  CustomerSelectContext,
  PurchaseRequestRecord,
} from "../types";

export interface UseAssistantChatOptions {
  businessId: string | null;
  locale: string;
  input: string;
  setInput: (v: string) => void;
  loadingParse: boolean;
  setLoadingParse: (v: boolean) => void;
  activeInvoiceId: string | null;
  latestPurchaseRequest: PurchaseRequestRecord | null;
  chatHistory?: ChatHistoryEntry[];
  products: Product[];
  clients: ContactRow[];
  manufacturers: ContactRow[];
  invoices: InvoiceRecord[];
  sales: SaleRecord[];
  currentCash: number;
  businessCurrency: string;
  parsed: ParsedSale | null;
  saleDraftInput: string;
  setSaleDraftInput: (v: string) => void;
  pendingSaleFlow: PendingSaleFlow | null;
  assistantQuestionContext: string | null;
  setAssistantQuestionContext: (ctx: string | null) => void;
  setAssistantInputHint: (hint: string | null) => void;
  setAssistantFollowUpInput: (v: string) => void;
  setAssistantReply: (msg: string | null) => void;
  setAssistantStockDraft: (draft: AssistantStockDraft | null) => void;
  setAssistantStockError: (err: string | null) => void;
  setCobroQrDraft: (draft: CobroQrDraftState | null) => void;
  setAssistantConfirmationRequest: (req: AssistantConfirmationRequest | null) => void;
  setAssistantConfirmationError: (err: string | null) => void;
  setAssistantConfirmationSubmitting: (v: boolean) => void;
  setParseMissingField: (v: MissingFieldHint | null) => void;
  setCustomerSelectContext: (v: CustomerSelectContext | null) => void;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  setActiveTab: (tab: string) => void;
  setActiveInvoiceId: (id: string | null) => void;
  setInvoiceSheetOpen: (open: boolean) => void;
  setSuccessNotice: (msg: string | null) => void;
  setParseError: (msg: string | null) => void;
  setConfirmError: (msg: string | null) => void;
  setInvoiceStatusNotice: (msg: FeedbackNotice | null) => void;
  setPurchaseActionNotice: (msg: string | null) => void;
  // C1: entryId pins the entry.id to the X-Idempotency-Key so the UI row
  // shares the same clientMessageId as the server row → P2002 collapse works.
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string, chips?: ChipsBundle | null, agentActivity?: import("../types").AgentActivity[], entryId?: string) => void;
  appendTransientReply: (text: string, agentActivity?: import("../types").AgentActivity[] | null) => void;
  // C3: entryId pins the durable reply entry to the server's replyClientMessageId
  // so /api/chat-history upsert collapses the two writes into one DB row.
  appendDurableReply: (text: string, chips?: ChipsBundle | null, agentActivity?: import("../types").AgentActivity[] | null, entryId?: string, widget?: import("../types").WidgetDescriptor | null) => void;
  updateProduct: (id: string, patch: Partial<Product>) => Promise<void>;
  updateSupplierField: (id: string, field: string, nextValue: string, currentValue: string | null | undefined) => Promise<void>;
  updateClientField: (id: string, field: string, nextValue: string, currentValue: string | null | undefined) => Promise<void>;
  updateInvoiceStatus: (id: string, status: "issued" | "sent" | "paid") => Promise<void>;
  downloadInvoicePdf: (id: string, num: string) => void;
  downloadPurchaseRequestPdf: (id: string, num: string) => void;
  setLatestPurchaseRequest: (req: PurchaseRequestRecord | null) => void;
  notifyChatSuccess?: (msg: string) => void;
  t: (en: string, es: string) => string;
  clearPendingSaleClarification: () => void;
  activatePendingSaleClarification: (flow: PendingSaleFlow) => void;
  continuePendingSaleClarification: (text: string, flow?: PendingSaleFlow | null) => Promise<boolean>;
  getRecoverablePendingSaleFlow: () => PendingSaleFlow | null;
  callParseSale: (text: string, hints?: { matchedProductId?: string | null; matchedCustomerId?: string | null }, priceOverrides?: Record<string, number>) => Promise<ParsedSale | null>;
  sendInvoiceToCustomer: (
    invoiceId: string,
    invoiceNumber: string,
    selectedCustomerPhone?: string | null
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>;
  dispatchSaleAction: <K extends SaleOrchestrationActionKey>(action: K, payload: SaleOrchestrationPayload<K>) => Promise<SaleOrchestrationResult<K>>;
  handleEditParsedSale: () => void;
  setPendingSaleFlow?: (flow: PendingSaleFlow | null) => void;
  assistantConfirmationRequest: AssistantConfirmationRequest | null;
  onConfirmationConfirm: () => Promise<void> | void;
  onConfirmationCancel: () => void;
}
