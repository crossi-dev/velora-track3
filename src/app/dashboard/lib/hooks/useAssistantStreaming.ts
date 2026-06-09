"use client";

import { useRef, useEffect } from "react";
import { useDashboardLang } from "../DashboardLangContext";
import {
  fetchWithTimeout,
  isClearChatCommand,
  getParsedSaleCommand,
  looksLikeParsedSaleCorrection,
  mergeParsedSaleCorrection,
  shouldContinueAssistantQuestionTurn,
  looksLikeFreshTopLevelTask,
} from "./utils";
import { looksLikeNewSaleIntent, type PendingSaleFlow } from "../pendingSaleFlow";
import type {
  SaleOrchestrationActionKey,
  SaleOrchestrationPayload,
  SaleOrchestrationResult,
} from "../actions/contracts";
import type {
  ChatHistoryEntry,
  AssistantConfirmationRequest,
  AssistantStockDraft,
  ParsedSale,
  MissingFieldHint,
  CustomerSelectContext,
  FeedbackNotice,
  PurchaseRequestRecord,
} from "../types";
import { parseAssistantResponse, type ParsedAssistantResponse } from "./assistant-chat-utils";
import { normalizeSpeechInput } from "@/lib/stt/normalize";
import { readAssistantSSE } from "./utils.sse";
import { handleClientAction } from "./useAssistantStreaming.clientActions";

// ── Action-chip token detection ─────────────────────────────────────────────
// Chip taps submit machine tokens (e.g. "enviar_link_pago|1100000000|cmpet4…")
// that are never human-readable text. Echoing them as a user bubble in chat
// would expose internal plumbing to the UI. Suppress the user-bubble for any
// known action-chip token format so the chat thread stays clean.
//
// Patterns covered:
//   - enviar_link_pago|{phone}|{paymentIntentId}
//   - cancelar_link_pago
//   - cliente:{id}
//   - configurar_courier:{provider}
//   - abrir_ajustes:{panel}
//   - comprá la opción … (marketplace external agent chip)
//   - confirm_whatsapp:{invoiceId}:{invoiceNumber}  (handled locally, but guard for safety)
const ACTION_CHIP_PREFIXES = [
  "enviar_link_pago|",
  "cancelar_link_pago",
  "cliente:",
  "configurar_courier:",
  "abrir_ajustes:",
  "confirm_whatsapp:",
] as const;

function isActionChipToken(text: string): boolean {
  const t = text.trim();
  return ACTION_CHIP_PREFIXES.some((prefix) =>
    prefix.endsWith("|") || prefix.endsWith(":")
      ? t.startsWith(prefix)
      : t === prefix,
  );
}

// Attach the open confirmationRequest to the last assistant entry of the
// chatHistory payload. The server-side confirmation fast-path reads it
// from there (see api/business-assistant/_lib/nlu/pending-confirmation.ts).
// Returns the input unchanged when no card is open or no assistant entry
// is present.
function attachPendingConfirmationToLastReply(
  history: ChatHistoryEntry[],
  confirmation: AssistantConfirmationRequest | null,
): ChatHistoryEntry[] | Array<ChatHistoryEntry & { confirmationRequest?: AssistantConfirmationRequest }> {
  if (!confirmation) return history;
  const lastReplyIndex = (() => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]?.kind === "reply") return i;
    }
    return -1;
  })();
  if (lastReplyIndex === -1) return history;
  return history.map((entry, i) =>
    i === lastReplyIndex ? { ...entry, confirmationRequest: confirmation } : entry,
  );
}

// ── Options ─────────────────────────────────────────────────────────

export interface UseAssistantStreamingOptions {
  businessId: string | null;
  locale: string;
  input: string;
  setInput: (v: string) => void;
  loadingParse: boolean;
  setLoadingParse: (v: boolean) => void;
  activeInvoiceId: string | null;
  latestPurchaseRequest: PurchaseRequestRecord | null;
  chatHistory?: ChatHistoryEntry[];
  // Snapshot of the open confirmation card, if any. Forwarded to the server
  // so the confirmation fast-path can short-circuit sí/no without invoking
  // the LLM (see nlu/confirmation-response.ts).
  assistantConfirmationRequest?: AssistantConfirmationRequest | null;
  // Callbacks fired when the server confirmation fast-path returns. These
  // mirror the in-card button-tap dispatch so the user sees the same
  // outcome whether they tap Confirmar or type "sí".
  onConfirmationConfirm?: () => Promise<void> | void;
  onConfirmationCancel?: () => void;
  parsed: ParsedSale | null;
  saleDraftInput: string;
  setSaleDraftInput: (v: string) => void;
  pendingSaleFlow: PendingSaleFlow | null;
  assistantQuestionContext: string | null;

  // Setters
  setAssistantQuestionContext: (ctx: string | null) => void;
  setAssistantInputHint: (hint: string | null) => void;
  setAssistantFollowUpInput: (v: string) => void;
  setAssistantReply: (msg: string | null) => void;
  setAssistantStockDraft: (draft: AssistantStockDraft | null) => void;
  setAssistantStockError: (err: string | null) => void;
  setAssistantConfirmationRequest: (
    req: AssistantConfirmationRequest | null
  ) => void;
  setAssistantConfirmationError: (err: string | null) => void;
  setAssistantConfirmationSubmitting: (v: boolean) => void;
  setParseMissingField: (v: MissingFieldHint | null) => void;
  setCustomerSelectContext: (v: CustomerSelectContext | null) => void;
  setParseError: (msg: string | null) => void;
  setConfirmError: (msg: string | null) => void;
  setSuccessNotice: (msg: string | null) => void;
  setInvoiceStatusNotice: (msg: FeedbackNotice | null) => void;
  setPurchaseActionNotice: (msg: string | null) => void;
  setPendingSaleFlow?: (flow: PendingSaleFlow | null) => void;

  // Chat history
  // C1: entryId (5th param) pins the entry.id to the X-Idempotency-Key so the
  // UI row and the server row share the same clientMessageId.
  appendChatHistoryEntry: (
    kind: ChatHistoryEntry["kind"],
    text: string,
    chips?: import("../types").ChipsBundle | null,
    agentActivity?: import("../types").AgentActivity[],
    entryId?: string,
  ) => void;
  appendTransientReply: (text: string, agentActivity?: import("../types").AgentActivity[] | null) => void;

  // Pending-sale flow
  clearPendingSaleClarification: () => void;
  activatePendingSaleClarification: (flow: PendingSaleFlow) => void;
  continuePendingSaleClarification: (
    text: string,
    flow?: PendingSaleFlow | null
  ) => Promise<boolean>;
  getRecoverablePendingSaleFlow: () => PendingSaleFlow | null;

  // Sale orchestration
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
  handleEditParsedSale: () => void;
  sendInvoiceToCustomer: (
    invoiceId: string,
    invoiceNumber: string,
    selectedCustomerPhone?: string | null
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>;
}

// ── Result types ────────────────────────────────────────────────────

export type StreamingResult =
  | { kind: "clear" }
  | { kind: "handled_locally" }
  | { kind: "needs_action"; parsed: ParsedAssistantResponse; rawInput: string }
  | { kind: "error"; message: string };

// ── Hook ────────────────────────────────────────────────────────────

/**
 * Handles the pre-fetch logic (clear commands, pending-sale flow,
 * parsed-sale corrections) and the fetch call to
 * `/api/business-assistant`. Returns the parsed response so the
 * orchestrator can hand it off to useAssistantActions.
 */
export function useAssistantStreaming(opts: UseAssistantStreamingOptions) {
  const { lang, t } = useDashboardLang();

  // Timer refs for clientAction side-effects — cleared on unmount to avoid
  // dispatching events/navigation into an unmounted component.
  const photoPickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mpOauthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pasteTextareaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (photoPickerTimerRef.current !== null) clearTimeout(photoPickerTimerRef.current);
      if (filePickerTimerRef.current !== null) clearTimeout(filePickerTimerRef.current);
      if (mpOauthTimerRef.current !== null) clearTimeout(mpOauthTimerRef.current);
      if (pasteTextareaTimerRef.current !== null) clearTimeout(pasteTextareaTimerRef.current);
    };
  }, []);

  /**
   * Resolve the user input: handle local commands, pending-sale flow,
   * parsed-sale corrections, and finally fetch the assistant API.
   *
   * The caller is responsible for guarding against double-submit and
   * for resetting `inFlightRef`.
   */
  async function resolveInput(
    submittedText?: string,
    continueAssistantQuestion = false,
    signal?: AbortSignal
  ): Promise<StreamingResult> {
    const baseText = (submittedText ?? opts.input).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    if (!baseText) return { kind: "handled_locally" };
    // Snapshot the pending confirmation BEFORE we reset UI state below —
    // the server-side fast-path needs to know what card was open when the
    // user typed sí/no. After `setAssistantConfirmationRequest(null)` the
    // value is gone.
    const pendingConfirmationSnapshot = opts.assistantConfirmationRequest ?? null;

    // ── Clear command ───────────────────────────────────────────────
    if (isClearChatCommand(baseText)) {
      opts.setInput("");
      void opts.dispatchSaleAction("sale.draft.cancel", {
        emitChatMessage: false,
      });
      opts.setAssistantReply(null);
      opts.setAssistantStockDraft(null);
      opts.setAssistantConfirmationRequest(null);
      opts.clearPendingSaleClarification();
      return { kind: "clear" };
    }

    const displayText = normalizeSpeechInput(baseText);
    // Action-chip tokens (e.g. "enviar_link_pago|…") are machine values, not
    // human text. Skip the user bubble so they never appear in chat history.
    if (!isActionChipToken(displayText)) {
      // C1: pin the entry.id to the current idempotency key so the UI row and
      // the server row share the same clientMessageId. P2002 collapse on the
      // server write then de-duplicates the two writes into one DB row.
      // The key is already published on window.__veloraIdempotencyKey by
      // publishIdempotencyKey() in useAssistantChat.ts before resolveInput runs.
      // Ref: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence
      const currentIdempotencyKey =
        typeof window !== "undefined"
          ? (window as unknown as { __veloraIdempotencyKey?: string }).__veloraIdempotencyKey
          : undefined;
      opts.appendChatHistoryEntry("user", displayText, null, undefined, currentIdempotencyKey);
    }
    opts.setInput("");

    // ── Pending-sale flow ───────────────────────────────────────────
    // Only continue a pending sale if the user's reply looks like a direct
    // answer (short, no new task intent). Otherwise clear it — the user
    // has moved on. This prevents "sticky state" where old sale prompts
    // trap the user across unrelated messages.
    const activePendingSaleFlow =
      opts.pendingSaleFlow ?? opts.getRecoverablePendingSaleFlow();

    if (activePendingSaleFlow) {
      const isShortReply = baseText.trim().split(/\s+/).length <= 4;
      const hasTaskIntent = looksLikeNewSaleIntent(baseText) || looksLikeFreshTopLevelTask(baseText);

      if (hasTaskIntent) {
        // New task — clear the pending sale and let the message through
        opts.clearPendingSaleClarification();
      } else if (isShortReply && /^\d|^\$/.test(baseText.trim())) {
        // Short numeric reply — likely answering the pending question
        if (!opts.pendingSaleFlow && activePendingSaleFlow) {
          opts.activatePendingSaleClarification(activePendingSaleFlow);
        }
        const handled = await opts.continuePendingSaleClarification(
          baseText,
          activePendingSaleFlow
        );
        if (handled) return { kind: "handled_locally" };
      } else {
        // Anything else (greetings, questions, etc.) — clear and let AI handle
        opts.clearPendingSaleClarification();
      }
    }

    // ── Wpp prompt contextual reply ─────────────────────────────────
    // When the last assistant bubble was the post-sale wpp prompt (detected
    // via chip value prefix, not text — text matching is fragile), "sí" and
    // synonyms resolve to an invoice send instead of a sale-draft confirm.
    if (!opts.parsed) {
      const lastReply = (opts.chatHistory ?? []).slice().reverse().find((e) => e.kind === "reply");
      const wppChipValue = lastReply?.chips?.options?.find((o) => o.value.startsWith("confirm_whatsapp:"))?.value;
      if (wppChipValue) {
        const wppAffirmations = new Set(["sí", "si", "sí.", "si.", "dale", "mandalo", "mandale"]);
        const normalized = baseText.trim().toLowerCase().replace(/[.!?,;:]+$/, "");
        if (wppAffirmations.has(normalized)) {
          const [invoiceId = "", invoiceNumber = ""] = wppChipValue.slice("confirm_whatsapp:".length).split(":");
          const wa = await opts.sendInvoiceToCustomer(invoiceId, invoiceNumber);
          const reply = wa.message;
          opts.setAssistantReply(reply);
          if (wa.ok) {
            opts.appendTransientReply(reply);
          } else {
            opts.appendChatHistoryEntry("error", reply);
          }
          return { kind: "handled_locally" };
        }
        if (normalized === "no" || normalized === "no gracias" || normalized === "no." || normalized === "no gracias.") {
          opts.setAssistantReply(t("Ok, no problem.", "Ok, sin problema."));
          opts.appendTransientReply(t("Ok, no problem.", "Ok, sin problema."));
          return { kind: "handled_locally" };
        }
      }
    }

    // ── Parsed-sale commands ────────────────────────────────────────
    if (opts.parsed) {
      const isNewSale = looksLikeNewSaleIntent(baseText);
      if (!isNewSale) {
        const cmd = getParsedSaleCommand(baseText);
        if (cmd === "confirm") {
          try {
            await opts.dispatchSaleAction("sale.confirm", {});
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : t("Could not complete the sale.", "No se pudo completar la venta.");
            opts.appendChatHistoryEntry("error", errMsg);
          }
          return { kind: "handled_locally" };
        }
        if (cmd === "confirm_whatsapp") {
          try {
            await opts.dispatchSaleAction("sale.confirm-and-send-whatsapp", {});
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : t("Could not complete the sale.", "No se pudo completar la venta.");
            opts.appendChatHistoryEntry("error", errMsg);
          }
          return { kind: "handled_locally" };
        }
        if (cmd === "edit") {
          void opts.handleEditParsedSale();
          return { kind: "handled_locally" };
        }
        if (cmd) return { kind: "handled_locally" };
      }

      if (!isNewSale && looksLikeParsedSaleCorrection(baseText)) {
        const mergedText = mergeParsedSaleCorrection(
          opts.saleDraftInput,
          baseText
        );
        opts.setLoadingParse(true);
        opts.setParseError(null);
        try {
          const result = await opts.callParseSale(mergedText);
          if (result) {
            await opts.dispatchSaleAction("sale.draft.update", {
              draft: result,
              source: "assistant",
            });
            opts.setSaleDraftInput(mergedText);
          }
        } catch (e) {
          opts.setParseError(
            e instanceof Error
              ? e.message
              : t("Could not correct the sale.", "No se pudo corregir la venta.")
          );
        } finally {
          opts.setLoadingParse(false);
        }
        return { kind: "handled_locally" };
      }
    }

    // Cancel existing draft if starting a new command
    if (opts.parsed) {
      await opts.dispatchSaleAction("sale.draft.cancel", {
        emitChatMessage: false,
      });
      opts.setSaleDraftInput("");
    }

    if (!opts.businessId) return { kind: "handled_locally" };

    // ── Build raw input with question context ───────────────────────
    const continueAssistantTurn = shouldContinueAssistantQuestionTurn(
      opts.assistantQuestionContext,
      baseText,
      continueAssistantQuestion
    );

    const rawInput =
      opts.assistantQuestionContext && continueAssistantTurn
        ? `${opts.assistantQuestionContext}\n${baseText}`
        : baseText;

    // ── Reset UI state ──────────────────────────────────────────────
    opts.setLoadingParse(true);
    opts.setParseError(null);
    opts.setParseMissingField(null);
    opts.setCustomerSelectContext(null);
    opts.setConfirmError(null);
    opts.setSuccessNotice(null);
    opts.setAssistantReply(null);
    opts.setAssistantStockDraft(null);
    opts.setAssistantStockError(null);
    opts.setAssistantConfirmationRequest(null);
    opts.setAssistantConfirmationError(null);
    opts.setAssistantConfirmationSubmitting(false);
    opts.setAssistantQuestionContext(null);
    opts.setAssistantInputHint(null);
    opts.setAssistantFollowUpInput("");
    opts.setPendingSaleFlow?.(null);
    opts.setInvoiceStatusNotice(null);
    opts.setPurchaseActionNotice(null);

    // ── Fetch ───────────────────────────────────────────────────────
    // 3-tier SSE timeout (MDN AbortSignal.any):
    // https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static
    //
    // Tier 1 — TTFT (Time-To-First-Token): 60 s AbortController.
    //   Armed when fetch starts; cleared on the first `event: ack` SSE frame.
    //   If the server never acks (hung before streaming begins), this fires
    //   and aborts the fetch via AbortSignal.any().
    // Tier 2 — Stall: 12 s timer (existing, in readAssistantSSE).
    //   Takes over after ack — detects mid-stream freezes (e.g. Gemini stall).
    // Tier 3 — Total: 90 s outer watchdog (existing, in useAssistantChat.ts).
    //   Absolute ceiling regardless of streaming state.
    const TTFT_MS = 60_000;
    const ttftController = new AbortController();
    const ttftTimerId = setTimeout(() => ttftController.abort("ttft-timeout"), TTFT_MS);
    // Hoisted outside the try block so catch can safely call it on error paths.
    const clearTtft = () => { clearTimeout(ttftTimerId); };
    // Combine user cancel + TTFT gate. Either source aborts the fetch.
    const combinedSignal = signal
      ? AbortSignal.any([signal, ttftController.signal])
      : ttftController.signal;

    try {
      const idempotencyKey =
        typeof window !== "undefined"
          ? (window as unknown as { __veloraIdempotencyKey?: string }).__veloraIdempotencyKey // custom property, not in Window typedef
          : undefined;

      // W4 SSE streaming: stable turn ID used as the streaming bubble entry key.
      // Format: "tmp:streaming-<idempotencyKey>" (or a random suffix as fallback).
      // The streaming bubble is appended once and updated in-place as chunks
      // arrive. On final/complete it is replaced by the durable assistant entry.
      const streamingTurnId = `tmp:streaming-${idempotencyKey ?? Math.random().toString(36).slice(2)}`;
      let streamingBubbleOpen = false;
      let streamingAccumulator = "";

      const onChunk = (text: string) => {
        streamingAccumulator += text;
        if (!streamingBubbleOpen) {
          // Open the streaming bubble on the first chunk.
          streamingBubbleOpen = true;
          opts.appendTransientReply(streamingAccumulator, undefined);
        } else {
          // Update the streaming bubble: replace the last transient entry with
          // the accumulated text so far.
          opts.setAssistantReply(streamingAccumulator);
        }
      };

      const res = await fetchWithTimeout("/api/business-assistant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({
          text: rawInput,
          businessId: opts.businessId,
          locale: opts.locale,
          lang,
          activeInvoiceId: opts.activeInvoiceId,
          latestPurchaseRequestId:
            opts.latestPurchaseRequest?.id ?? null,
          latestPurchaseRequestNumber:
            opts.latestPurchaseRequest?.requestNumber ?? null,
          chatHistory: attachPendingConfirmationToLastReply(
            (opts.chatHistory ?? []).slice(-6),
            pendingConfirmationSnapshot,
          ),
        }),
      // 90 s outer cap (server LLM_TIMEOUT_MS=80 s wins cleanly; TTFT gate
      // handles the more likely "server hung before ack" case at 60 s).
      }, 90_000, combinedSignal);

      // W4: pass onChunk so streaming bubbles are updated as tokens arrive.
      // On the non-streaming fast-path no chunks are emitted, so onChunk is
      // never called and the legacy complete-envelope path is used unchanged.
      void streamingTurnId; // used for documentation; key lives in appendTransientReply
      const data = await readAssistantSSE(
        res,
        t("Could not process the request.", "No se pudo procesar la solicitud."),
        onChunk,
        clearTtft, // Tier 1: clear TTFT timer on ack
      );
      const parsed = parseAssistantResponse(data);

      // Fix #2: all clientAction side-effects extracted to sibling module to keep
      // this file under the 400-line budget (CLAUDE.md Code Size Contract).
      // Ref: module extraction pattern — https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence
      const clientActionResult = await handleClientAction(
        data,
        parsed,
        pendingConfirmationSnapshot,
        { photoPickerTimerRef, filePickerTimerRef, mpOauthTimerRef, pasteTextareaTimerRef },
        {
          appendTransientReply: opts.appendTransientReply,
          setAssistantReply: opts.setAssistantReply,
          setAssistantConfirmationRequest: opts.setAssistantConfirmationRequest,
          onConfirmationConfirm: opts.onConfirmationConfirm,
          onConfirmationCancel: opts.onConfirmationCancel,
        },
      );
      if (clientActionResult.kind === "handled_locally") {
        return { kind: "handled_locally" };
      }

      // Handle confirmation requests inline (they short-circuit actions)
      if (parsed.confirmationRequest) {
        const confReply =
          parsed.assistantAnswer ?? parsed.confirmationRequest.message;
        opts.setAssistantReply(confReply);
        opts.appendTransientReply(confReply);
        opts.setAssistantConfirmationRequest(parsed.confirmationRequest);
        return { kind: "handled_locally" };
      }

      return { kind: "needs_action", parsed, rawInput };
    } catch (error) {
      // Always clear the TTFT timer — it may still be pending if the error
      // occurred before ack (e.g. network failure, 401, or the TTFT itself fired).
      clearTtft();
      // User-initiated cancel — re-throw so the orchestrator can silence it.
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      const errMsg =
        error instanceof Error
          ? error.message
          : t("Could not process the request.", "No se pudo procesar la solicitud.");
      return { kind: "error", message: errMsg };
    }
  }

  return { resolveInput };
}
