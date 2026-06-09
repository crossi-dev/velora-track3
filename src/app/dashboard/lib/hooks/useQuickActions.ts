"use client";

import { useState, type FormEvent } from "react";
import { clearMutationKeysForAction } from "./utils";
import { executeDashboardAction } from "../actions/executeDashboardAction";
import { buildManualSaleDraftFromIntake } from "../actions/saleDraftNode";
import { getAppSettings } from "../appSettings";
import type { SaleOrchestrationPayload } from "../actions/contracts";
import type { ProductCreatePayload } from "../actions/contracts-payloads";
import type {
  Product,
  ContactRow,
  QuickActionMode,
  TabKey,
  ChatHistoryEntry,
} from "../types";

interface useQuickActionsOptions {
  businessId: string | null;
  products: Product[];
  clients: ContactRow[];
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  setQuickAction: (action: QuickActionMode) => void;
  setQuickActionError: (msg: string | null) => void;
  setQuickActionSaving: (saving: boolean) => void;
  setSuccessNotice: (msg: string | null) => void;
  setErrorNotice: (msg: string | null) => void;
  setUndoAction?: (fn: (() => Promise<void>) | null) => void;
  setActiveTab: (tab: TabKey) => void;
  setActiveInvoiceId: (id: string | null) => void;
  markUpdated: (key: string) => void;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
  dispatchSaleAction: (
    action: "sale.draft.open",
    payload: SaleOrchestrationPayload<"sale.draft.open">
  ) => Promise<{ ok: true }>;
  t: (en: string, es: string) => string;
}

export function useQuickActions(opts: useQuickActionsOptions) {
  const {
    businessId,
    products,
    clients,
    loadBusiness,
    setQuickAction,
    setQuickActionError,
    setQuickActionSaving,
    setSuccessNotice,
    setErrorNotice,
    setUndoAction,
    setActiveTab,
    setActiveInvoiceId,
    markUpdated,
    appendChatHistoryEntry,
    dispatchSaleAction,
    t,
  } = opts;

  const [quickStock, setQuickStock] = useState({
    productId: "",
    quantity: "",
    unitCost: "",
    note: "",
  });

  const [quickMovement, setQuickMovement] = useState({
    // "withdrawal" added 2026-06-03 — sangría / retiro de efectivo de caja.
    type: "purchase" as "purchase" | "tax" | "salary" | "adjustment" | "income" | "withdrawal",
    amount: "",
    description: "",
  });

  const [quickProduct, setQuickProduct] = useState({
    name: "",
    price: "",
    stock: "",
    sku: "",
    costPrice: "",
    weightGrams: "",
  });

  const [quickSale, setQuickSale] = useState({
    productId: "",
    quantity: "",
    customerId: "",
    unitPrice: "",
  });

  async function handleQuickStockSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!businessId) return;

    const quantity = Math.floor(Number(quickStock.quantity));
    if (!quickStock.productId || !Number.isFinite(quantity) || quantity <= 0) {
      setQuickActionError(t("Elegí un producto y una cantidad mayor a 0.", "Elegí un producto y una cantidad mayor a 0."));
      return;
    }

    const selectedProduct = products.find((p) => p.id === quickStock.productId);
    if (!selectedProduct) {
      setQuickActionError(t("El producto seleccionado ya no existe. Elegí otro.", "El producto seleccionado ya no existe. Elegí otro."));
      return;
    }

    setQuickActionSaving(true);
    const stockPayload: {
      productId: string;
      quantity: number;
      unitPrice: number | null;
      note: string | null;
      createPurchaseRequest: boolean;
    } = {
      productId: selectedProduct.id,
      quantity,
      unitPrice: quickStock.unitCost ? Number(quickStock.unitCost) : null,
      note: quickStock.note.trim() || null,
      createPurchaseRequest: false,
    };

    try {
      await executeDashboardAction("stock-load.create", stockPayload);

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("inventory");
      const stockMsg = t("Listo, actualicé el stock.", "Listo, actualicé el stock.");
      setSuccessNotice(stockMsg);
      setErrorNotice(null);
      setUndoAction?.(async () => {
        await executeDashboardAction("undo.execute", { target: "stock", count: 1 });
        clearMutationKeysForAction("stock-load.create");
        await loadBusiness({ silent: true, force: true }).catch(() => {});
        appendChatHistoryEntry("success", t("Stock undone.", "Stock deshecho."));
      });
      setQuickStock({ productId: "", quantity: "", unitCost: "", note: "" });
      setQuickAction(null);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : t("Could not complete this action.", "No pude completar esta acción.");
      appendChatHistoryEntry("error", errMsg);
      setQuickActionError(errMsg);
    } finally {
      setQuickActionSaving(false);
    }
  }

  async function handleQuickMovementSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!businessId) return;

    const amount = Number(quickMovement.amount);
    if (!Number.isFinite(amount) || amount === 0 || !quickMovement.description.trim()) {
      setQuickActionError(t("Tipo, monto y descripción son obligatorios.", "Tipo, monto y descripción son obligatorios."));
      return;
    }

    setQuickActionSaving(true);
    const movementPayload = {
      type: quickMovement.type,
      description: quickMovement.description.trim(),
      amount,
    };
    try {
      await executeDashboardAction("cash-movement.create", movementPayload);

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("cash");
      const movementMsg = t("Listo, registré el movimiento.", "Listo, registré el movimiento.");
      setSuccessNotice(movementMsg);
      setErrorNotice(null);
      setUndoAction?.(async () => {
        await executeDashboardAction("undo.execute", { target: "cash-movement", count: 1 });
        clearMutationKeysForAction("cash-movement.create");
        await loadBusiness({ silent: true, force: true }).catch(() => {});
        appendChatHistoryEntry("success", t("Cash movement undone.", "Movimiento de caja deshecho."));
      });
      setQuickMovement({ type: "purchase", amount: "", description: "" });
      setQuickAction(null);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : t("Could not complete this action.", "No pude completar esta acción.");
      appendChatHistoryEntry("error", errMsg);
      setQuickActionError(errMsg);
    } finally {
      setQuickActionSaving(false);
    }
  }

  async function handleQuickProductSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!businessId) return;

    const name = quickProduct.name.trim();
    const price = Number(quickProduct.price);
    const stock = Math.floor(Number(quickProduct.stock));
    if (!name || !Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || stock < 0) {
      setQuickActionError(t("Nombre, precio >= 0 e inventario >= 0 son obligatorios.", "Nombre, precio >= 0 e inventario >= 0 son obligatorios."));
      return;
    }

    const sku = quickProduct.sku.trim() || undefined;
    const costPrice = quickProduct.costPrice !== "" && Number.isFinite(Number(quickProduct.costPrice))
      ? Number(quickProduct.costPrice)
      : undefined;
    const weightGrams = quickProduct.weightGrams !== "" &&
      Number.isInteger(Number(quickProduct.weightGrams)) &&
      Number(quickProduct.weightGrams) > 0
        ? Number(quickProduct.weightGrams)
        : undefined;

    setQuickActionSaving(true);
    const productPayload: ProductCreatePayload = { businessId, name, price, stock };
    if (sku !== undefined) productPayload.sku = sku;
    if (costPrice !== undefined) productPayload.costPrice = costPrice;
    if (weightGrams !== undefined) productPayload.weightGrams = weightGrams;
    try {
      await executeDashboardAction("product.create", productPayload);

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("inventory");
      const productMsg = t("Listo, agregué el producto.", "Listo, agregué el producto.");
      setSuccessNotice(productMsg);
      setErrorNotice(null);
      setUndoAction?.(async () => {
        await executeDashboardAction("undo.execute", { target: "product-create", count: 1 });
        clearMutationKeysForAction("product.create");
        await loadBusiness({ silent: true, force: true }).catch(() => {});
        appendChatHistoryEntry("success", t("Product undone.", "Producto deshecho."));
      });
      setQuickProduct({ name: "", price: "", stock: "", sku: "", costPrice: "", weightGrams: "" });
      setQuickAction(null);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : t("Could not complete this action.", "No pude completar esta acción.");
      appendChatHistoryEntry("error", errMsg);
      setQuickActionError(errMsg);
    } finally {
      setQuickActionSaving(false);
    }
  }

  async function handleQuickSaleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!businessId) return;

    if (quickSale.productId && !products.some((p) => p.id === quickSale.productId)) {
      setQuickActionError(t("El producto seleccionado ya no existe. Elegí otro.", "El producto seleccionado ya no existe. Elegí otro."));
      return;
    }

    const draftResult = buildManualSaleDraftFromIntake({
      productId: quickSale.productId,
      quantity: quickSale.quantity,
      customerId: quickSale.customerId,
      unitPrice: quickSale.unitPrice,
      allowNegativeStock: getAppSettings().allowNegativeStock,
      products,
      clients,
    });

    if (!("draft" in draftResult) || !draftResult.draft) {
      setQuickActionError(draftResult.error ?? t("No se pudo preparar el borrador de venta.", "No se pudo preparar el borrador de venta."));
      return;
    }

    const nextDraft = draftResult.draft;
    setQuickActionError(null);
    void dispatchSaleAction("sale.draft.open", {
      draft: nextDraft,
      source: "manual_quick_action",
    });
    const draftMsg = t("Listo, el borrador de venta está preparado para confirmar.", "Listo, el borrador de venta está preparado para confirmar.");
    setSuccessNotice(draftMsg);
    setErrorNotice(null);
    setQuickSale({ productId: "", quantity: "", customerId: "", unitPrice: "" });
    setQuickAction(null);
    setActiveTab("main");
    setActiveInvoiceId(null);
  }

  return {
    quickStock, setQuickStock,
    quickMovement, setQuickMovement,
    quickProduct, setQuickProduct,
    quickSale, setQuickSale,
    handleQuickStockSubmit,
    handleQuickMovementSubmit,
    handleQuickProductSubmit,
    handleQuickSaleSubmit
  };
}
