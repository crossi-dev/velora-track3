"use client";

import { useEffect, useRef } from "react";
import {
  buildDashboardDraftSnapshot,
  hasDashboardDraftContent,
  parseDashboardDraftSnapshot,
} from "./dashboard-draft-persistence";
import type {
  PurchaseRequestRecord,
  AssistantStockDraft,
  AssistantConfirmationRequest,
  ParsedSale,
  Product,
  ContactRow,
} from "./types";

export const PERSISTENCE_KEY_PREFIX = "velora-dashboard-draft:";

interface UseDraftPersistenceOptions {
  persistenceKey: string | null;

  // Hydration targets
  setLatestPurchaseRequest: (req: PurchaseRequestRecord | null) => void;
  setAssistantStockDraft: (draft: AssistantStockDraft | null) => void;
  setAssistantConfirmationRequest: (req: AssistantConfirmationRequest | null) => void;
  setAssistantQuestionContext: (ctx: string | null) => void;
  setAssistantInputHint: (hint: string | null) => void;

  // Sync sources
  latestPurchaseRequest: PurchaseRequestRecord | null;
  assistantStockDraft: AssistantStockDraft | null;
  assistantConfirmationRequest: AssistantConfirmationRequest | null;
  assistantQuestionContext: string | null;
  assistantInputHint: string | null;

  // Purchase request validation
  manufacturers: ContactRow[];

  // Draft price validation
  products: Product[];
  parsed: ParsedSale | null;
  setParsed: (sale: ParsedSale) => void;
  setDraftPriceValidated: (v: boolean) => void;
}

export function useDraftPersistence(opts: UseDraftPersistenceOptions): void {
  const {
    persistenceKey,
    setLatestPurchaseRequest,
    setAssistantStockDraft,
    setAssistantConfirmationRequest,
    setAssistantQuestionContext,
    setAssistantInputHint,
    latestPurchaseRequest,
    assistantStockDraft,
    assistantConfirmationRequest,
    assistantQuestionContext,
    assistantInputHint,
    manufacturers,
    products,
    parsed,
    setParsed,
    setDraftPriceValidated,
  } = opts;

  const persistenceHydratedRef = useRef(false);
  const draftPriceValidatedRef = useRef(false);

  // Hydration Effect
  useEffect(() => {
    if (!persistenceKey || persistenceHydratedRef.current) return;
    try {
      const draft = parseDashboardDraftSnapshot(localStorage.getItem(persistenceKey));
      if (draft) {
        if (draft.latestPurchaseRequest) {
          setLatestPurchaseRequest(draft.latestPurchaseRequest);
        }
        if (draft.assistantStockDraft) {
          setAssistantStockDraft(draft.assistantStockDraft);
        }
        if (draft.assistantConfirmationRequest) {
          setAssistantConfirmationRequest(draft.assistantConfirmationRequest);
        }
        if (draft.assistantQuestionContext) {
          setAssistantQuestionContext(draft.assistantQuestionContext);
        }
        if (draft.assistantInputHint) {
          setAssistantInputHint(draft.assistantInputHint);
        }
      }
    } catch (e) {
      console.error("Dashboard hydration error:", e);
    }
    persistenceHydratedRef.current = true;
  }, [persistenceKey]);

  // Validate rehydrated purchase request against fresh supplier list.
  // The ref is set AFTER the check runs so that if latestPurchaseRequest
  // arrives asynchronously after manufacturers, the effect re-fires and
  // correctly clears a stale request with an invalid supplier.
  const purchaseRequestValidatedRef = useRef(false);
  useEffect(() => {
    if (purchaseRequestValidatedRef.current || manufacturers.length === 0) return;
    if (!latestPurchaseRequest?.payload?.supplier?.name) {
      purchaseRequestValidatedRef.current = true;
      return;
    }
    const supplierExists = manufacturers.some(
      (s) => s.name === latestPurchaseRequest.payload!.supplier.name
    );
    if (!supplierExists) {
      setLatestPurchaseRequest(null);
    }
    purchaseRequestValidatedRef.current = true;
  }, [manufacturers, latestPurchaseRequest]);

  // Sync Effect
  useEffect(() => {
    if (!persistenceKey || !persistenceHydratedRef.current) return;
    const draft = buildDashboardDraftSnapshot({
      latestPurchaseRequest,
      assistantStockDraft,
      assistantConfirmationRequest,
      assistantQuestionContext,
      assistantInputHint,
    });

    if (!hasDashboardDraftContent(draft)) {
      localStorage.removeItem(persistenceKey);
      return;
    }

    try {
      localStorage.setItem(persistenceKey, JSON.stringify(draft));
    } catch (err) {
      console.error("[dashboard-draft] No se pudo guardar el borrador del panel en localStorage (cuota excedida). El borrador de recuperación ante cierre no estará disponible.", err);
    }
  }, [
    persistenceKey,
    latestPurchaseRequest,
    assistantStockDraft,
    assistantConfirmationRequest,
    assistantQuestionContext,
    assistantInputHint,
  ]);

  // Reset price validation whenever the draft changes so the validation effect re-runs
  // against the latest product prices.
  useEffect(() => {
    draftPriceValidatedRef.current = false;
    setDraftPriceValidated(false);
  }, [parsed]);

  // Re-validate rehydrated sale draft prices against current catalog.
  useEffect(() => {
    if (draftPriceValidatedRef.current || products.length === 0 || !parsed) return;
    draftPriceValidatedRef.current = true;
    let hasInvalid = false;
    const updatedItems = parsed.items.map(item => {
      const product = products.find(p => p.id === item.productId);
      if (!product) {
        hasInvalid = true;
        return { ...item, invalidProduct: true };
      }
      const keepExistingPrice = item.unitPrice > 0;
      const catalogPrice = Number(product.price) || 0;
      return { ...item, invalidProduct: undefined, unitPrice: keepExistingPrice ? item.unitPrice : catalogPrice };
    });
    const changed = updatedItems.some((item, i) => {
      const orig = parsed!.items[i];
      return item.unitPrice !== orig.unitPrice || item.invalidProduct !== orig.invalidProduct;
    });
    if (changed) {
      setParsed({ ...parsed, items: updatedItems });
    }
    if (!hasInvalid) {
      setDraftPriceValidated(true);
    }
  }, [products, parsed]);
}
