"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { useIdleHelpPrompt, IDLE_HELP_PROMPT_EVENT } from "../lib/hooks/useIdleHelpPrompt";
import type {
  ParsedSale,
  AssistantStockDraftState,
  AssistantStockDraftItem,
  CobroQrDraftState,
  PurchaseRequestRecord,
  BusinessSummary,
  ChatHistoryEntry,
  MissingFieldHint,
  CustomerSelectContext,
  AssistantConfirmationRequest
} from "../lib/types";

import { AssistantHistory } from "./assistant/AssistantHistory";
import { AssistantSaleDraft } from "./assistant/AssistantSaleDraft";
import { AssistantStockDraft } from "./assistant/AssistantStockDraft";
import { AssistantCobroQrDraft } from "./assistant/AssistantCobroQrDraft";
import { AssistantConfirmation } from "./assistant/AssistantConfirmation";
import { AssistantInputBar } from "./assistant/AssistantInputBar";
import { AssistantPurchaseRequestPanel } from "./assistant/AssistantPurchaseRequestPanel";
import { AssistantCustomerSelect } from "./assistant/AssistantCustomerSelect";
import { AssistantMobileFab } from "./assistant/AssistantMobileFab";
import { AssistantFilePreview } from "./assistant/AssistantFilePreview";
import { AssistantPhotoProductDraft } from "./assistant/AssistantPhotoProductDraft";
import { Button } from "@/components/ui/button";
import { useFileUpload } from "../lib/hooks/useFileUpload";
import { usePhotoExtract } from "../lib/hooks/usePhotoExtract";
import { usePhotoExtractCustomers } from "../lib/hooks/usePhotoExtractCustomers";
import { useRole } from "../lib/contexts";
import { getAppSettings } from "../lib/appSettings";

interface AssistantInputProps {
  input: string;
  setInput: (value: string) => void;
  chatHistory?: ChatHistoryEntry[];
  traceLoading?: boolean;
  traceError?: boolean;
  loadingParse: boolean;
  parseError: string | null;
  parseMissingField: MissingFieldHint | null;
  quickActionError: string | null;
  successNotice: string | null;
  parsed: ParsedSale | null;
  setParsed: (value: ParsedSale | null) => void;
  parsedSaleChatCount: number | null;
  confirming: boolean;
  confirmError: string | null;
  setConfirmError: (value: string | null) => void;
  assistantReply: string | null;
  assistantStockDraft: AssistantStockDraftState | null;
  setAssistantStockDraft: (value: AssistantStockDraftState | null) => void;
  assistantStockSaving: boolean;
  assistantStockError: string | null;
  setAssistantStockError: (value: string | null) => void;
  cobroQrDraft: CobroQrDraftState | null;
  setCobroQrDraft: (value: CobroQrDraftState | null) => void;
  appendCobroChatHistoryEntry: (kind: "user" | "reply" | "success" | "error", text: string) => void;
  loadBusiness: (opts?: { silent?: boolean }) => Promise<void>;
  assistantConfirmationRequest: AssistantConfirmationRequest | null;
  assistantConfirmationSubmitting: boolean;
  assistantConfirmationError: string | null;
  assistantQuestionContext: string | null;
  assistantInputHint: string | null;
  latestPurchaseRequest: PurchaseRequestRecord | null;
  latestPurchaseRequestPayload: PurchaseRequestRecord["payload"] | undefined;
  purchaseActionNotice: string | null;
  setPurchaseActionNotice: (value: string | null) => void;
  downloadingPurchaseRequestId: string | null;
  saleDraftRef: RefObject<HTMLDivElement | null>;
  business: BusinessSummary;
  handleMissingFieldSubmit: (value: string) => void;
  handleCustomerSelect: (customerName: string) => void;
  customerSelectContext: CustomerSelectContext | null;
  handleEditParsedSale: () => void;
  handleCancelParsedSale: () => void;
  handleConfirm: () => void;
  handleConfirmAndSendWhatsapp?: () => void;
  handleAssistantConfirmationConfirm: () => void;
  handleAssistantConfirmationCancel: () => void;
  handleAssistantStockDraftDismiss: () => void;
  handleAssistantStockSubmit: (event: FormEvent<HTMLFormElement>) => void;
  updateAssistantStockField: (field: "supplierName", value: string) => void;
  updateAssistantStockItem: (index: number, field: keyof AssistantStockDraftItem, value: string) => void;
  downloadPurchaseRequestPdf: (requestId: string, requestNumber: string) => void;
  sendPurchaseRequestToSupplier: () => Promise<string | void>;
  moneyFmt: (value: unknown, currency: string) => string;
  t: (en: string, es: string) => string;
  handleGo: (text?: string, continueAssistantQuestion?: boolean) => void;
  abortCurrentRequest: () => void;
  clients: { id: string; name: string }[];
  onManualSale?: () => void;
  catalogNames?: string[];
  /** When true, suppresses the decorative Velora mark in the chat empty state.
   *  Set by DashboardTabContent when SetupChecklist is rendered above the chat
   *  to avoid an orphaned logo floating between the two components. */
  hideEmptyMark?: boolean;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function AssistantInput(props: AssistantInputProps) {
  const {
    input,
    setInput,
    chatHistory = [],
    traceLoading = false,
    traceError = false,
    loadingParse,
    parseError,
    parseMissingField,
    quickActionError,
    parsed,
    setParsed,
    confirming,
    confirmError,
    assistantReply,
    assistantStockDraft,
    setAssistantStockDraft,
    assistantStockSaving,
    assistantStockError,
    setAssistantStockError,
    cobroQrDraft,
    setCobroQrDraft,
    appendCobroChatHistoryEntry,
    loadBusiness,
    assistantConfirmationRequest,
    assistantConfirmationSubmitting,
    assistantConfirmationError,
    assistantQuestionContext,
    assistantInputHint,
    latestPurchaseRequest,
    latestPurchaseRequestPayload,
    purchaseActionNotice,
    downloadingPurchaseRequestId,
    saleDraftRef,
    business,
    handleGo,
    abortCurrentRequest,
    handleMissingFieldSubmit,
    handleCustomerSelect,
    customerSelectContext,
    handleEditParsedSale,
    handleCancelParsedSale,
    handleConfirm,
    handleConfirmAndSendWhatsapp,
    handleAssistantConfirmationConfirm,
    handleAssistantConfirmationCancel,
    handleAssistantStockDraftDismiss,
    handleAssistantStockSubmit,
    updateAssistantStockField,
    updateAssistantStockItem,
    downloadPurchaseRequestPdf,
    sendPurchaseRequestToSupplier,
    moneyFmt,
    t,
    clients,
    onManualSale,
  } = props;
  const hideEmptyMark = props.hideEmptyMark ?? false;

  const visibleChatHistory = chatHistory.filter((entry) => !entry.id.startsWith("trace:"));
  const chatThreadBottomRef = useRef<HTMLDivElement | null>(null);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  ));
  const pendingInputRef = useRef("");
  const [focusTrigger, setFocusTrigger] = useState(0);
  const role = useRole();

  // T1 idle nudge — heuristic: last non-user visible message contains the T1 prompt.
  // When the owner hasn't interacted for 45 s, a "Contame más" chip appears.
  const lastNonUserEntry = [...visibleChatHistory].reverse().find((e) => e.kind !== "user");
  const isT1Pending =
    role === "owner" &&
    visibleChatHistory.filter((e) => e.kind === "user").length === 0 &&
    typeof lastNonUserEntry?.text === "string" &&
    lastNonUserEntry.text.includes("¿Cómo se llama tu negocio?");

  const [showIdleChip, setShowIdleChip] = useState(false);
  const idleResetRef = useRef<() => void>(() => undefined);

  useIdleHelpPrompt({ enabled: isT1Pending, resetRef: idleResetRef });

  // Hide the chip as soon as T1 is resolved (owner responded or advanced).
  useEffect(() => {
    if (!isT1Pending) setShowIdleChip(false);
  }, [isT1Pending]);

  // Listen for the idle event and surface the chip.
  useEffect(() => {
    const handler = () => { if (isT1Pending) setShowIdleChip(true); };
    window.addEventListener(IDLE_HELP_PROMPT_EVENT, handler);
    return () => window.removeEventListener(IDLE_HELP_PROMPT_EVENT, handler);
  }, [isT1Pending]);

  // Reset idle timer whenever the owner types (input changes) or sends a message.
  // Using input as the dependency is equivalent to keydown-level reset without
  // needing a new prop on AssistantInputBar.
  useEffect(() => {
    if (isT1Pending && input.length > 0) {
      setShowIdleChip(false);
      idleResetRef.current();
    }
  }, [input, isT1Pending]);

  const handleIdleChipClick = useCallback(() => {
    setShowIdleChip(false);
    idleResetRef.current();
    handleGo("Contame más");
  }, [handleGo]);

  // Chip suggestions fill input (non-empty) so the post-send focus guard won't fire.
  // Increment focusTrigger so AssistantInputBar focuses regardless of input value.
  const setInputWithFocus = useCallback((val: string) => {
    setInput(val);
    if (val) setFocusTrigger((n) => n + 1);
  }, [setInput]);
  const {
    uploadPreview,
    uploadLoading,
    uploadError,
    handleFileSelect,
    handleImportConfirm,
    handleImportDismiss,
  } = useFileUpload();
  // Derive success message from the sentinel-prefixed error string so
  // AssistantFilePreview receives a dedicated prop instead of multiplexing
  // success through the error channel.
  const uploadSuccessMsg = uploadError?.startsWith("__success__")
    ? uploadError.replace("__success__", "")
    : null;
  const uploadDisplayError = uploadSuccessMsg ? null : uploadError;

  const {
    photoProducts,
    setPhotoProducts,
    photoLoading,
    photoError,
    photoSuccess,
    handlePhotoSelect,
    handlePhotoConfirm,
    handlePhotoDismiss,
  } = usePhotoExtract({ businessId: props.business?.id ?? null, onCreated: () => { /* refresh handled by useBusinessData polling */ } });

  const {
    handleCustomerPhotoSelect,
  } = usePhotoExtractCustomers({ businessId: props.business?.id ?? null, onCreated: () => { /* refresh handled by useBusinessData polling */ } });

  // One-line prime per project_three_permissions_primed: shown before the
  // camera picker opens so the dueño understands why we're asking for
  // access. Auto-clears after 4s or when a photo is selected.
  const [photoPrime, setPhotoPrime] = useState<string | null>(null);
  const photoPrimeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { return () => { if (photoPrimeTimerRef.current) clearTimeout(photoPrimeTimerRef.current); }; }, []);
  const handlePhotoPrime = useCallback((msg: string) => {
    if (photoPrimeTimerRef.current) clearTimeout(photoPrimeTimerRef.current);
    setPhotoPrime(msg);
    photoPrimeTimerRef.current = setTimeout(() => setPhotoPrime(null), 4000);
  }, []);
  const handlePhotoSelectWithPrimeClear = useCallback((file: File) => {
    setPhotoPrime(null);
    void handlePhotoSelect(file);
  }, [handlePhotoSelect]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setKeyboardInset(Math.max(0, window.innerHeight - vv.offsetTop - vv.height));
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    const updateViewport = () => {
      setIsMobileViewport(window.innerWidth < 768);
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  // Scroll-to-bottom is owned by AssistantHistory (virtualizer.scrollToIndex on
  // chatHistory length change). Two scrollIntoView effects here fought the
  // virtualizer and re-fired on every state change (parsed, assistantReply,
  // loadingParse...), causing the "rebote" — removed.

  const hasResponse = Boolean(
    visibleChatHistory.length > 0 ||
    loadingParse ||
    parsed ||
    assistantReply ||
    assistantConfirmationRequest ||
    assistantConfirmationError ||
    cobroQrDraft ||
    latestPurchaseRequest?.payload ||
    parseError ||
    parseMissingField ||
    customerSelectContext ||
    quickActionError
  );
  const hasSecondaryPanel = Boolean(
    parsed ||
    assistantStockDraft ||
    cobroQrDraft ||
    assistantConfirmationRequest ||
    latestPurchaseRequest?.payload ||
    uploadPreview ||
    uploadSuccessMsg ||
    photoProducts ||
    photoSuccess ||
    (customerSelectContext?.clients.length ?? 0) > 0
  );

  const allowShortReply = Boolean(assistantQuestionContext || parsed || parseMissingField || assistantStockDraft || cobroQrDraft);

  const keyboardOpen = keyboardInset > 0;

  return (
    <div
      className="assistant-shell"
      style={{
        position: "relative",
        display: "grid",
        gridTemplateRows: "1fr auto",
        backgroundColor: "var(--background)",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        overscrollBehavior: "none" as const,
        paddingBottom: keyboardOpen ? keyboardInset : undefined,
        boxSizing: "border-box",
      }}
    >
      <AssistantHistory
        chatHistory={visibleChatHistory}
        traceLoading={traceLoading}
        traceError={traceError}
        hasResponse={hasResponse}
        loadingParse={loadingParse}
        parseError={parseError}
        parseMissingField={parseMissingField}
        quickActionError={quickActionError}
        hideEmptyMark={hideEmptyMark}
        handleGo={handleGo}
        handleMissingFieldSubmit={handleMissingFieldSubmit}
        t={t}
        setInput={setInputWithFocus}
        pendingInputRef={pendingInputRef}
        chatThreadBottomRef={chatThreadBottomRef}
        onScroll={undefined}
      />

      {hasSecondaryPanel && (
        <div
          className="assistant-thread-column w-full px-0 pt-0 pb-0 md:px-3 md:pt-3 md:pb-3"
          style={{
            ...((parsed || assistantStockDraft || cobroQrDraft || assistantConfirmationRequest) ? {
              backgroundColor: "transparent",
              borderRadius: isMobileViewport ? "12px" : "var(--radius-xl)",
              transition: "background-color 250ms ease",
              padding: isMobileViewport ? "4px 0" : "16px 12px",
            } : {}),
            maxHeight: isMobileViewport ? "45vh" : "50vh",
            overflowY: "auto" as const,
            flexShrink: 0,
          }}
        >
          {parsed && (
            <AssistantSaleDraft
              parsed={parsed}
              setParsed={setParsed}
              confirming={confirming}
              confirmError={confirmError}
              business={business}
              clients={clients}
              handleConfirm={handleConfirm}
              handleConfirmAndSendWhatsapp={handleConfirmAndSendWhatsapp}
              handleEditParsedSale={handleEditParsedSale}
              handleCancelParsedSale={handleCancelParsedSale}
              moneyFmt={moneyFmt}
              t={t}
              saleDraftRef={saleDraftRef}
            />
          )}

          {assistantStockDraft && (
            <AssistantStockDraft
              assistantStockDraft={assistantStockDraft}
              setAssistantStockDraft={setAssistantStockDraft}
              assistantStockSaving={assistantStockSaving}
              assistantStockError={assistantStockError}
              setAssistantStockError={setAssistantStockError}
              handleAssistantStockSubmit={handleAssistantStockSubmit}
              updateAssistantStockField={updateAssistantStockField}
              updateAssistantStockItem={updateAssistantStockItem}
              onDismiss={handleAssistantStockDraftDismiss}
              t={t}
            />
          )}

          {cobroQrDraft && (
            <AssistantCobroQrDraft
              draft={cobroQrDraft}
              setDraft={setCobroQrDraft}
              appendChatHistoryEntry={appendCobroChatHistoryEntry}
              loadBusiness={loadBusiness}
              moneyFmt={(n) => moneyFmt(n, business.currency)}
              t={t}
            />
          )}

          {assistantConfirmationRequest && (
            <AssistantConfirmation
              assistantConfirmationRequest={assistantConfirmationRequest}
              assistantConfirmationSubmitting={assistantConfirmationSubmitting}
              assistantConfirmationError={assistantConfirmationError}
              handleAssistantConfirmationConfirm={handleAssistantConfirmationConfirm}
              handleAssistantConfirmationCancel={handleAssistantConfirmationCancel}
              t={t}
            />
          )}

          {latestPurchaseRequest?.payload && (
            <AssistantPurchaseRequestPanel
              latestPurchaseRequest={latestPurchaseRequest}
              latestPurchaseRequestPayload={latestPurchaseRequestPayload}
              downloadingPurchaseRequestId={downloadingPurchaseRequestId}
              purchaseActionNotice={purchaseActionNotice}
              downloadPurchaseRequestPdf={downloadPurchaseRequestPdf}
              sendPurchaseRequestToSupplier={sendPurchaseRequestToSupplier}
              moneyFmt={moneyFmt}
              t={t}
            />
          )}

          {(uploadPreview || uploadSuccessMsg) && (
            <AssistantFilePreview
              preview={uploadPreview ?? { importType: "products", count: 0, rows: [], previewItems: [] }}
              loading={uploadLoading}
              error={uploadDisplayError}
              successMsg={uploadSuccessMsg}
              onConfirm={handleImportConfirm}
              onDismiss={handleImportDismiss}
              t={t}
            />
          )}

          {photoProducts && (
            <AssistantPhotoProductDraft
              products={photoProducts}
              setProducts={setPhotoProducts}
              loading={photoLoading}
              error={photoError}
              handleConfirm={handlePhotoConfirm}
              handleDismiss={handlePhotoDismiss}
              t={t}
            />
          )}
          {!photoProducts && photoSuccess && (
            <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--brand)", padding: "8px 12px" }}>{photoSuccess}</p>
          )}
          {!photoProducts && photoError && !photoLoading && (
            <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--danger)", padding: "8px 12px" }}>{photoError}</p>
          )}

          {customerSelectContext && customerSelectContext.clients.length > 0 && getAppSettings().showAssistantSuggestions && (
            <AssistantCustomerSelect
              customerSelectContext={customerSelectContext}
              handleCustomerSelect={handleCustomerSelect}
            />
          )}
        </div>
      )}

      {isMobileViewport && onManualSale && !hasResponse && (
        <AssistantMobileFab onManualSale={onManualSale} t={t} />
      )}

      {photoPrime && (
        <p
          className="text-caption"
          style={{
            fontFamily: "var(--font-dm-sans)",
            fontWeight: 500,
            color: "var(--tone-body)",
            backgroundColor: "var(--surface-subtle)",
            padding: "8px 16px",
            borderTop: "1px solid var(--border)",
            margin: 0,
            textAlign: "center",
          }}
        >
          {photoPrime}
        </p>
      )}

      {showIdleChip && (
        <div
          aria-label="Sugerencia proactiva"
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "6px 16px",
            backgroundColor: "var(--background)",
            borderTop: "1px solid var(--border)",
          }}
        >
          <Button
            type="button"
            onClick={handleIdleChipClick}
            variant="outline"
            className="rounded-full font-semibold hover:bg-[var(--brand-soft)] hover:text-[color:var(--brand)]"
            style={{
              minHeight: "44px",
              minWidth: "44px",
              fontFamily: "var(--font-dm-sans)",
              fontSize: "0.875rem",
              lineHeight: 1.5,
              backgroundColor: "var(--brand-soft)",
              borderColor: "var(--brand-soft)",
              color: "var(--brand)",
              whiteSpace: "nowrap",
            }}
          >
            Contame más
          </Button>
        </div>
      )}

      <AssistantInputBar
        input={input}
        setInput={setInput}
        handleGo={handleGo}
        abortCurrentRequest={abortCurrentRequest}
        loadingParse={loadingParse}
        assistantQuestionContext={assistantQuestionContext}
        assistantInputHint={assistantInputHint}
        allowShortReply={allowShortReply}
        t={t}
        pendingInputRef={pendingInputRef}
        isMobileViewport={isMobileViewport}
        catalogNames={props.catalogNames}
        onFileSelect={role === "owner" ? handleFileSelect : undefined}
        onPhotoSelect={role === "owner" ? handlePhotoSelectWithPrimeClear : undefined}
        onCustomerPhotoSelect={role === "owner" ? handleCustomerPhotoSelect : undefined}
        onPhotoPrime={handlePhotoPrime}
        focusTrigger={focusTrigger}
        messageCount={visibleChatHistory.length}
      />

      <style jsx>{`
        .assistant-shell { min-height: 0; position: relative; }
        .assistant-thread-column { max-width: 48rem; margin: 0 auto; }
        @media (max-width: 767px) {
          .assistant-mobile-sale-fab:active {
            transform: scale(0.96);
          }
          .assistant-thread-column {
            max-width: none;
            margin: 0;
          }
        }
      `}</style>
    </div>
  );
}
