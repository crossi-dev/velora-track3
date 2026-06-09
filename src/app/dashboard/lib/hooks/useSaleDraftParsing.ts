"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  buildPendingSaleQuestionContext,
  defaultPendingSaleInputHint,
  recoverPendingSaleFlow,
  type PendingSaleFlow,
} from "../pendingSaleFlow";
import {
  GENERIC_SALE_DRAFT_KEY,
  GENERIC_PENDING_SALE_FLOW_KEY,
  scopedKey,
} from "./sale-draft-utils";
import type {
  ChatHistoryEntry,
  ParsedSale,
  MissingFieldHint,
  Product,
  ContactRow,
  CustomerSelectContext,
} from "../types";
import type {
  SaleOrchestrationActionKey,
  SaleOrchestrationPayload,
  SaleOrchestrationResult,
  SaleDraftSource,
} from "../actions/contracts";
import { useSaleDraftPersistence } from "./useSaleDraftParsing.persistence";
import { createCallParseSale } from "./useSaleDraftParsing.api";
import {
  continuePendingSaleClarification as continuePendingSaleClarificationImpl,
  handleMissingFieldSubmit as handleMissingFieldSubmitImpl,
  handleCustomerSelect as handleCustomerSelectImpl,
  type ClarificationDeps,
} from "./useSaleDraftParsing.clarification";

/* ------------------------------------------------------------------ */
/*  Options                                                           */
/* ------------------------------------------------------------------ */

export interface UseSaleDraftParsingOptions {
  businessId: string | null;
  locale: string;
  input: string;
  setInput: (value: string) => void;
  setLoadingParse: (v: boolean) => void;
  products: Product[];
  clients: ContactRow[];
  assistantReply: string | null;
  setAssistantReply: (msg: string | null) => void;
  assistantQuestionContext: string | null;
  setAssistantQuestionContext: (ctx: string | null) => void;
  assistantInputHint: string | null;
  setAssistantInputHint: (hint: string | null) => void;
  setAssistantFollowUpInput: (v: string) => void;
  setParseError: (msg: string | null) => void;
  setConfirmError: (msg: string | null) => void;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
  appendTransientReply: (text: string) => void;
  clearStaleSaleDraftPrompt?: () => void;
  onHandleGo: (text: string) => void;

  /* Callbacks provided by orchestrator so parsing can trigger draft actions */
  dispatchSaleAction: <K extends SaleOrchestrationActionKey>(
    action: K,
    payload: SaleOrchestrationPayload<K>
  ) => Promise<SaleOrchestrationResult<K>>;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useSaleDraftParsing(opts: UseSaleDraftParsingOptions) {
  const {
    businessId,
    locale,
    products,
    clients,
    setLoadingParse,
    setParseError,
    setConfirmError,
    appendChatHistoryEntry,
    appendTransientReply,
    clearStaleSaleDraftPrompt,
    dispatchSaleAction,
  } = opts;

  const SALE_DRAFT_KEY = scopedKey(GENERIC_SALE_DRAFT_KEY, businessId);
  const PENDING_SALE_FLOW_KEY = scopedKey(GENERIC_PENDING_SALE_FLOW_KEY, businessId);

  /* ---- state ---------------------------------------------------- */

  const [parsed, setParsedRaw] = useState<ParsedSale | null>(null);
  const setParsed = useCallback((value: ParsedSale | null) => {
    setParsedRaw(value);
  }, []);

  const [parsedSaleChatCount, setParsedSaleChatCount] = useState<number | null>(null);
  const [saleDraftInput, setSaleDraftInput] = useState("");
  const [pendingSaleFlow, setPendingSaleFlowRaw] = useState<PendingSaleFlow | null>(null);
  const [parseMissingField, setParseMissingField] = useState<MissingFieldHint | null>(null);
  const [customerSelectContext, setCustomerSelectContext] = useState<CustomerSelectContext | null>(null);

  const pendingSaleTextRef = useRef<string | null>(null);
  const pendingEditRestoreRef = useRef<string | null>(null);

  /** Monotonically increasing counter used to detect stale async operations
   *  (e.g. a WhatsApp send that was queued for a draft that has since been
   *  replaced by a new sale intent). Bumped on every draft open/cancel. */
  const saleFlowGenRef = useRef(0);

  const setPendingSaleFlow = useCallback((value: PendingSaleFlow | null) => {
    setPendingSaleFlowRaw(value);
  }, []);

  /* ---- hydration / persistence (extracted) ---------------------- */

  useSaleDraftPersistence({
    saleDraftKey: SALE_DRAFT_KEY,
    pendingSaleFlowKey: PENDING_SALE_FLOW_KEY,
    businessId,
    parsed,
    setParsedRaw,
  });

  /* ---- sync effects --------------------------------------------- */

  useEffect(() => {
    if (pendingSaleFlow?.missingField === "price" && pendingSaleFlow.priceProductId && pendingSaleFlow.priceProductName) {
      setParseMissingField({
        type: "price",
        productId: pendingSaleFlow.priceProductId,
        productName: pendingSaleFlow.priceProductName,
      });
    } else {
      setParseMissingField(null);
    }

    if (pendingSaleFlow?.missingField === "customer" && pendingSaleFlow.customerOptions?.length) {
      setCustomerSelectContext({
        saleText: pendingSaleFlow.saleText,
        clients: pendingSaleFlow.customerOptions,
      });
    } else {
      setCustomerSelectContext(null);
    }
  }, [pendingSaleFlow]);

  useEffect(() => {
    if (!pendingSaleFlow) return;

    if (!opts.assistantQuestionContext) {
      opts.setAssistantQuestionContext(buildPendingSaleQuestionContext(pendingSaleFlow));
    }

    if (!opts.assistantInputHint) {
      opts.setAssistantInputHint(pendingSaleFlow.inputHint ?? defaultPendingSaleInputHint(pendingSaleFlow.missingField));
    }

    if (pendingSaleFlow.missingField !== "price" && !opts.assistantReply) {
      opts.setAssistantReply(pendingSaleFlow.answer);
    }
  }, [
    pendingSaleFlow,
    opts.assistantInputHint,
    opts.assistantQuestionContext,
    opts.assistantReply,
    opts.setAssistantInputHint,
    opts.setAssistantQuestionContext,
    opts.setAssistantReply,
  ]);

  useEffect(() => {
    // Skip only when nothing is loaded at all — using || would prevent cleanup
    // for a real business with zero clients (e.g. deleted), leaving stale
    // parseMissingField/customerSelectContext blocking the sale indefinitely.
    if (products.length === 0 && clients.length === 0) return;

    if (parseMissingField?.productId) {
      const exists = products.some(p => p.id === parseMissingField.productId);
      if (!exists) {
        setParseMissingField(null);
      }
    }

    if (customerSelectContext?.clients?.length) {
      const clientIds = new Set(clients.map(c => c.id));
      const valid = customerSelectContext.clients.filter(c => clientIds.has(c.id));
      if (valid.length === 0) {
        setCustomerSelectContext(null);
      } else if (valid.length !== customerSelectContext.clients.length) {
        setCustomerSelectContext({ ...customerSelectContext, clients: valid });
      }
    }
  }, [products, clients, parseMissingField, customerSelectContext]);

  /* ---- clarification helpers (state-owning) --------------------- */

  const clearPendingSaleClarification = useCallback(() => {
    setPendingSaleFlow(null);
    opts.setAssistantQuestionContext(null);
    opts.setAssistantInputHint(null);
    opts.setAssistantFollowUpInput("");
    setParseMissingField(null);
    setCustomerSelectContext(null);
  }, [setPendingSaleFlow, opts]);

  const clearSharedSaleDraft = useCallback(() => {
    saleFlowGenRef.current += 1;
    clearPendingSaleClarification();
    clearStaleSaleDraftPrompt?.();
    setParsed(null);
    setSaleDraftInput("");
    setParseError(null);
    setConfirmError(null);
    opts.setAssistantReply(null);
  }, [clearPendingSaleClarification, clearStaleSaleDraftPrompt, setConfirmError, setParseError, setParsed, opts]);

  const openSharedSaleDraft = useCallback(
    (draft: ParsedSale, source: SaleDraftSource = "assistant") => {
      saleFlowGenRef.current += 1;
      clearPendingSaleClarification();
      setParsed(draft);
      setParseError(null);
      setConfirmError(null);
      opts.setAssistantReply(null);
      if (source === "manual_quick_action") {
        opts.setAssistantQuestionContext(null);
        opts.setAssistantInputHint(null);
        opts.setAssistantFollowUpInput("");
      }
    },
    [
      clearPendingSaleClarification,
      setConfirmError,
      setParseError,
      setParsed,
      opts,
    ]
  );

  const activatePendingSaleClarification = useCallback((flow: PendingSaleFlow) => {
    setPendingSaleFlow(flow);
    opts.setAssistantQuestionContext(buildPendingSaleQuestionContext(flow));
    opts.setAssistantInputHint(flow.inputHint ?? defaultPendingSaleInputHint(flow.missingField));
    opts.setAssistantFollowUpInput("");

    if (flow.missingField === "price" && flow.priceProductId && flow.priceProductName) {
      setParseMissingField({
        type: "price",
        productId: flow.priceProductId,
        productName: flow.priceProductName,
      });
      opts.setAssistantReply(null);
    } else {
      setParseMissingField(null);
      opts.setAssistantReply(flow.answer);
    }

    if (flow.missingField === "customer" && flow.customerOptions?.length) {
      setCustomerSelectContext({
        saleText: flow.saleText,
        clients: flow.customerOptions,
      });
    } else {
      setCustomerSelectContext(null);
    }
  }, [setPendingSaleFlow, opts]);

  const getRecoverablePendingSaleFlow = useCallback(() => {
    return recoverPendingSaleFlow({
      saleText: saleDraftInput || pendingSaleFlow?.saleText || customerSelectContext?.saleText || null,
      questionContext: opts.assistantQuestionContext,
      answer: opts.assistantReply,
      inputHint: opts.assistantInputHint,
      parseMissingField: parseMissingField
        ? {
            productId: parseMissingField.productId,
            productName: parseMissingField.productName,
          }
        : null,
      customerSelectContext: customerSelectContext
        ? {
            saleText: customerSelectContext.saleText,
            clients: customerSelectContext.clients,
          }
        : null,
    });
  }, [
    opts.assistantInputHint,
    opts.assistantQuestionContext,
    opts.assistantReply,
    customerSelectContext,
    parseMissingField,
    pendingSaleFlow,
    saleDraftInput,
  ]);

  /* ---- parse API call (extracted) ------------------------------- */

  const callParseSale = createCallParseSale({
    businessId,
    locale,
    pendingSaleFlow,
    setPendingSaleFlow,
    setParseMissingField,
    setParseError,
    appendTransientReply,
    activatePendingSaleClarification,
  });

  /* ---- clarification handlers (extracted, deps-injected) -------- */

  const clarificationDeps: ClarificationDeps = {
    input: opts.input,
    saleDraftInput,
    setSaleDraftInput,
    pendingSaleFlow,
    parseMissingField,
    setParseMissingField,
    customerSelectContext,
    setCustomerSelectContext,
    products,
    clients,
    setLoadingParse,
    setParseError,
    setAssistantReply: opts.setAssistantReply,
    appendTransientReply,
    appendChatHistoryEntry,
    clearPendingSaleClarification,
    callParseSale,
    dispatchSaleAction,
    onHandleGo: opts.onHandleGo,
  };

  async function continuePendingSaleClarification(replyText: string, flowOverride?: PendingSaleFlow | null) {
    return continuePendingSaleClarificationImpl(clarificationDeps, replyText, flowOverride);
  }

  async function handleMissingFieldSubmit(value: string) {
    return handleMissingFieldSubmitImpl(clarificationDeps, value);
  }

  function handleCustomerSelect(customerName: string) {
    handleCustomerSelectImpl(clarificationDeps, customerName);
  }

  /* ---- public API ----------------------------------------------- */

  return {
    parsed,
    setParsed,
    parsedSaleChatCount,
    setParsedSaleChatCount,
    saleDraftInput,
    setSaleDraftInput,
    pendingSaleFlow,
    setPendingSaleFlow,
    parseMissingField,
    setParseMissingField,
    customerSelectContext,
    setCustomerSelectContext,
    saleFlowGenRef,
    pendingSaleTextRef,
    pendingEditRestoreRef,
    clearPendingSaleClarification,
    clearSharedSaleDraft,
    openSharedSaleDraft,
    activatePendingSaleClarification,
    getRecoverablePendingSaleFlow,
    callParseSale,
    continuePendingSaleClarification,
    handleMissingFieldSubmit,
    handleCustomerSelect,
  };
}
