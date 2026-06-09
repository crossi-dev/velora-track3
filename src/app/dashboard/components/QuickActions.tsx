"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Package, ArrowsDownUp, Plus, UserPlus, ShoppingCart } from "@phosphor-icons/react";
import type { Product, ContactRow } from "@/domain";
import type { QuickActionMode, TabKey } from "../lib/types";
import type { MovementType } from "../lib/command-parsers/shared";
import { QuickMenuPanel } from "./QuickMenuPanel";
import { QuickStockForm } from "./QuickStockForm";
import { QuickMovementForm } from "./QuickMovementForm";
import { QuickProductForm } from "./QuickProductForm";
import { QuickSaleForm } from "./QuickSaleForm";

export function QuickActionIcon({ actionKey }: { actionKey: string }) {
  const size = 16;
  const weight = "bold" as const;
  if (actionKey === "sale")     return <ShoppingCart size={size} weight={weight} />;
  if (actionKey === "stock")    return <Package size={size} weight={weight} />;
  if (actionKey === "movement") return <ArrowsDownUp size={size} weight={weight} />;
  if (actionKey === "client") return <UserPlus size={size} weight={weight} />;
  return <Plus size={size} weight={weight} />;
}

interface QuickActionsProps {
  quickAction: QuickActionMode;
  setQuickAction: (action: QuickActionMode) => void;
  setActiveTab: (tab: TabKey) => void;
  quickActionSaving: boolean;
  products: Product[];
  quickStock: { productId: string; quantity: string; unitCost: string; note: string };
  setQuickStock: (updater: (current: { productId: string; quantity: string; unitCost: string; note: string }) => { productId: string; quantity: string; unitCost: string; note: string }) => void;
  quickMovement: { type: MovementType; amount: string; description: string };
  setQuickMovement: (updater: (current: { type: MovementType; amount: string; description: string }) => { type: MovementType; amount: string; description: string }) => void;
  quickProduct: { name: string; price: string; stock: string; sku: string; costPrice: string; weightGrams: string };
  setQuickProduct: (updater: (current: { name: string; price: string; stock: string; sku: string; costPrice: string; weightGrams: string }) => { name: string; price: string; stock: string; sku: string; costPrice: string; weightGrams: string }) => void;
  quickSale: { productId: string; quantity: string; customerId: string; unitPrice: string };
  setQuickSale: (updater: (current: { productId: string; quantity: string; customerId: string; unitPrice: string }) => { productId: string; quantity: string; customerId: string; unitPrice: string }) => void;
  clients: ContactRow[];
  handleQuickStockSubmit: (event: FormEvent<HTMLFormElement>) => void;
  handleQuickMovementSubmit: (event: FormEvent<HTMLFormElement>) => void;
  handleQuickProductSubmit: (event: FormEvent<HTMLFormElement>) => void;
  handleQuickSaleSubmit: (event: FormEvent<HTMLFormElement>) => void;
  businessCurrency: string;
  t: (en: string, es: string) => string;
}

export function QuickActions({
  quickAction,
  setQuickAction,
  setActiveTab,
  quickActionSaving,
  products,
  quickStock,
  setQuickStock,
  quickMovement,
  setQuickMovement,
  quickProduct,
  setQuickProduct,
  quickSale,
  setQuickSale,
  clients,
  handleQuickStockSubmit,
  handleQuickMovementSubmit,
  handleQuickProductSubmit,
  handleQuickSaleSubmit,
  businessCurrency,
  t,
}: QuickActionsProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [keyboardInset, setKeyboardInset] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const updateInset = () => {
      const vh = window.innerHeight;
      const vv = window.visualViewport?.height ?? vh;
      setKeyboardInset(Math.max(0, vh - vv));
    };
    window.visualViewport.addEventListener("resize", updateInset);
    window.visualViewport.addEventListener("scroll", updateInset);
    updateInset();
    return () => {
      window.visualViewport?.removeEventListener("resize", updateInset);
      window.visualViewport?.removeEventListener("scroll", updateInset);
    };
  }, []);

  useEffect(() => {
    if (!quickAction) return;

    // Skip events from the same interaction that opened the panel (touch-through guard)
    let armed = false;
    const armTimer = requestAnimationFrame(() => { armed = true; });

    const closePanel = () => setQuickAction(null);

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!armed) return;
      if (!panelRef.current) return;
      if (panelRef.current.contains(event.target as Node)) return;
      closePanel();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown, { passive: true });
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      cancelAnimationFrame(armTimer);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [quickAction, setQuickAction]);

  return (
    <div ref={panelRef} className="quick-actions-no-lines">
      {quickAction === "menu" && (
        <QuickMenuPanel setActiveTab={setActiveTab} setQuickAction={setQuickAction} t={t} />
      )}

      {quickAction === "stock" && (
        <QuickStockForm
          setQuickAction={setQuickAction}
          quickActionSaving={quickActionSaving}
          products={products}
          quickStock={quickStock}
          setQuickStock={setQuickStock}
          handleQuickStockSubmit={handleQuickStockSubmit}
          keyboardInset={keyboardInset}
          t={t}
        />
      )}

      {quickAction === "movement" && (
        <QuickMovementForm
          setQuickAction={setQuickAction}
          quickActionSaving={quickActionSaving}
          quickMovement={quickMovement}
          setQuickMovement={setQuickMovement}
          handleQuickMovementSubmit={handleQuickMovementSubmit}
          keyboardInset={keyboardInset}
          t={t}
        />
      )}

      {quickAction === "product" && (
        <QuickProductForm
          setQuickAction={setQuickAction}
          quickActionSaving={quickActionSaving}
          quickProduct={quickProduct}
          setQuickProduct={setQuickProduct}
          handleQuickProductSubmit={handleQuickProductSubmit}
          keyboardInset={keyboardInset}
          t={t}
        />
      )}

      {quickAction === "sale" && (
        <QuickSaleForm
          setQuickAction={setQuickAction}
          quickActionSaving={quickActionSaving}
          products={products}
          quickSale={quickSale}
          setQuickSale={setQuickSale}
          clients={clients}
          handleQuickSaleSubmit={handleQuickSaleSubmit}
          businessCurrency={businessCurrency}
          keyboardInset={keyboardInset}
          t={t}
        />
      )}
    </div>
  );
}
