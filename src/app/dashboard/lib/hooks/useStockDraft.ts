"use client";

import { useState, useRef, FormEvent } from "react";
import { tLang } from "../DashboardLangContext";
import { executeDashboardAction } from "../actions/executeDashboardAction";
import { getAppSettings } from "../appSettings";
import { buildAssistantCancellationMessage } from "../assistant-flow-chat";
import { buildStockLoadSuccessMessage } from "../stock-load-chat";
import { normalizePersonOrBusinessName } from "./utils";
import { classifyErrorForUser } from "./useAssistantChat.errors";
import type {
  AssistantStockDraft,
  AssistantStockDraftItem,
  PurchaseRequestRecord,
} from "../types";

interface UseStockDraftOptions {
  businessId: string | null;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  setSuccessNotice: (msg: string | null) => void;
  setErrorNotice: (msg: string | null) => void;
  setParseError: (msg: string | null) => void;
  setConfirmError: (msg: string | null) => void;
  setInput: (value: string) => void;
  setActiveTab: (tab: string) => void;
  setLatestPurchaseRequest: (req: PurchaseRequestRecord | null) => void;
  setPurchaseActionNotice: (msg: string | null) => void;
  setAssistantReply: (msg: string | null) => void;
  appendChatHistoryEntry: (kind: "user" | "reply" | "success" | "error", text: string) => void;
  notifyChatSuccess?: (msg: string) => void;
}

export function useStockDraft(opts: UseStockDraftOptions) {
  const {
    businessId,
    loadBusiness,
    setSuccessNotice,
    setErrorNotice,
    setParseError,
    setConfirmError,
    setInput,
    setActiveTab,
    setLatestPurchaseRequest,
    setPurchaseActionNotice,
    setAssistantReply,
    appendChatHistoryEntry,
    notifyChatSuccess,
  } = opts;

  const [assistantStockDraft, setAssistantStockDraft] = useState<AssistantStockDraft | null>(null);
  const [assistantStockError, setAssistantStockError] = useState<string | null>(null);
  const [assistantStockSaving, setAssistantStockSaving] = useState(false);
  const lastAssistantStockMovementIdsRef = useRef<string[]>([]);

  function updateAssistantStockItem(index: number, field: keyof AssistantStockDraftItem, value: string) {
    setAssistantStockDraft((current) => {
      if (!current) return current;
      const items = current.items.map((item, i) => i === index ? { ...item, [field]: value } : item);
      return { ...current, items };
    });
    setAssistantStockError(null);
  }

  function handleAssistantStockDraftDismiss() {
    const dismissMsg = buildAssistantCancellationMessage("stock_draft");
    appendChatHistoryEntry("reply", dismissMsg);
    setAssistantStockDraft(null);
    setAssistantStockError(null);
    setAssistantReply(null);
  }

  async function handleAssistantStockSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (assistantStockSaving) return;
    if (!businessId || !assistantStockDraft) return;

    const supplierName = normalizePersonOrBusinessName(assistantStockDraft.supplierName);

    const createPurchaseRequestEl = event.currentTarget.elements.namedItem("createPurchaseRequest");
    const createPurchaseRequest = createPurchaseRequestEl
      ? (createPurchaseRequestEl as HTMLInputElement).value === "true"
      : Boolean(supplierName);

    for (let i = 0; i < assistantStockDraft.items.length; i++) {
      const item = assistantStockDraft.items[i];
      const itemName = item.itemName.trim();
      const quantity = Math.floor(Number(item.quantity));
      const unitPrice = Number(item.unitPrice);

      if (!itemName || !Number.isFinite(quantity) || quantity <= 0) {
        setAssistantStockError(
          assistantStockDraft.items.length > 1
            ? tLang(`Item ${i + 1} needs a valid name and quantity.`, `El ítem ${i + 1} necesita nombre y cantidad válida.`)
            : tLang("Item name and quantity are required.", "El ítem y la cantidad son obligatorios.")
        );
        return;
      }

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        setAssistantStockError(
          assistantStockDraft.items.length > 1
            ? tLang(`Unit price for item ${i + 1} must be 0 or more.`, `El precio unitario del ítem ${i + 1} debe ser 0 o mayor.`)
            : tLang("Unit price must be 0 or more.", "El precio unitario debe ser 0 o mayor.")
        );
        return;
      }
    }

    setAssistantStockSaving(true);
    setAssistantStockError(null);
    setSuccessNotice(null);
    setParseError(null);
    setConfirmError(null);

    const totalItems = assistantStockDraft.items.length;
    let succeededCount = 0;

    try {
      let lastPurchaseRequest: PurchaseRequestRecord | null = null;
      const loadedNames: string[] = [];
      const collectedMovementIds: string[] = [];
      const failedItems: { name: string; reason: string }[] = [];

      for (const item of assistantStockDraft.items) {
        const itemName = item.itemName.trim();
        const quantity = Math.floor(Number(item.quantity));
        const unitPrice = Number(item.unitPrice);

        try {
          const data = await executeDashboardAction("stock-load.create", {
            itemName,
            quantity,
            unitPrice,
            // supplierName and note must be omitted (not null) — schema uses
            // .optional(), not .nullable(); sending null fails strict Zod parse.
            ...(supplierName ? { supplierName } : {}),
            createPurchaseRequest,
            autoCreateProduct: getAppSettings().autoCreateProductOnStockLoad,
          });

          const movId = (data as { stockLoad?: { stockMovementId?: unknown } }).stockLoad?.stockMovementId;
          if (typeof movId === "string" && movId.length > 0) collectedMovementIds.push(movId);
          if (data.request) lastPurchaseRequest = data.request as PurchaseRequestRecord;
          loadedNames.push(`${quantity} ${itemName}`);
          succeededCount++;
        } catch (itemError) {
          // Classify before storing — raw error text must not surface to chat.
          const rawReason = itemError instanceof Error ? itemError.message : tLang("Unknown error", "Error desconocido");
          failedItems.push({
            name: itemName,
            reason: classifyErrorForUser(rawReason).message,
          });
        }
      }
      lastAssistantStockMovementIdsRef.current = collectedMovementIds;
      await loadBusiness({ silent: true, force: true }).catch(() => {});

      if (failedItems.length > 0 && succeededCount === 0) {
        const errMsg = failedItems.map((f) => `Error en "${f.name}": ${f.reason}.`).join(" ");
        appendChatHistoryEntry("error", errMsg);
        setAssistantStockError(errMsg);
      } else if (failedItems.length > 0) {
        const itemSummary = loadedNames.join(", ");
        const failedSummary = failedItems.map((f) => `"${f.name}": ${f.reason}`).join("; ");
        const msg = tLang(`Done, saved: ${itemSummary}. Pending: ${failedSummary}.`, `Listo, guardé: ${itemSummary}. Quedaron pendientes: ${failedSummary}.`);
        setSuccessNotice(tLang(`Saved ${succeededCount} of ${totalItems} items. The pending ones are left for you to correct.`, `Guardé ${succeededCount} de ${totalItems} ítems. Te dejo los pendientes para corregir.`));
        setErrorNotice(null);
        notifyChatSuccess?.(msg);
        setAssistantStockError(msg);
        setAssistantStockDraft((current) => {
          if (!current) return current;
          const failedNames = new Set(failedItems.map((f) => f.name));
          return { ...current, items: current.items.filter((i) => failedNames.has(i.itemName.trim())) };
        });
        setLatestPurchaseRequest(lastPurchaseRequest);
        setPurchaseActionNotice(null);
      } else {
        const itemSummary = loadedNames.join(", ");
        const stockSuccessMessage = buildStockLoadSuccessMessage(
          itemSummary,
          lastPurchaseRequest?.requestNumber ?? null
        );

        setAssistantStockDraft(null);
        setAssistantReply(null);
        setInput("");
        setSuccessNotice(stockSuccessMessage);
        setErrorNotice(null);
        setLatestPurchaseRequest(lastPurchaseRequest);
        setPurchaseActionNotice(null);
        setActiveTab(lastPurchaseRequest ? "main" : "inventory");
      }
    } catch {
      const errMsg = tLang("Could not complete the stock load.\nLet's review the data and try again.", "No pude completar la carga de stock.\nRevisemos los datos y la intento de nuevo.");
      appendChatHistoryEntry("error", errMsg);
      setAssistantStockError(errMsg);
      await loadBusiness({ silent: true, force: true }).catch(() => {});
    } finally {
      setAssistantStockSaving(false);
    }
  }

  return {
    assistantStockDraft,
    setAssistantStockDraft,
    assistantStockError,
    setAssistantStockError,
    assistantStockSaving,
    lastAssistantStockMovementIdsRef,
    updateAssistantStockItem,
    handleAssistantStockDraftDismiss,
    handleAssistantStockSubmit,
  };
}
