"use client";

import { executeDashboardAction } from "../actions/executeDashboardAction";
import { useDashboardLang } from "../DashboardLangContext";
import type { Product } from "../types";

interface useInventoryOptions {
  businessId: string | null;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  markUpdated: (key: string) => void;
  setPageError: (msg: string | null) => void;
  setUndoAction?: (fn: (() => Promise<void>) | null) => void;
  appendChatHistoryEntry: (kind: "user" | "reply" | "success" | "error", text: string) => void;
  products: Product[];
}

export function useInventory(opts: useInventoryOptions) {
  const { businessId, loadBusiness, markUpdated } = opts;
  const { t } = useDashboardLang();

  async function updateProduct(productId: string, patch: Partial<Product>) {
    if (!businessId) return;
    try {
      const hasStockPatch = typeof patch.stock === "number";
      const nonStockPatch: Partial<Product> = { ...patch };
      delete nonStockPatch.stock;

      if (hasStockPatch) {
        await executeDashboardAction("stock.adjust", {
          id: productId,
          stock: patch.stock as number,
          stockReason: "inventory_manual_edit",
        });
      }

      if (Object.keys(nonStockPatch).length > 0) {
        await executeDashboardAction("product.update", { id: productId, ...nonStockPatch });
      }

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("products");

      // Wire undo for inline stock adjustments so the inventory edit UI
      // gets the same affordance as the quick stock-load action.
      if (hasStockPatch) {
        opts.setUndoAction?.(async () => {
          await executeDashboardAction("undo.execute", { target: "stock", count: 1 });
          await loadBusiness({ silent: true, force: true }).catch(() => {});
          opts.appendChatHistoryEntry("success", t("Stock adjustment undone.", "Ajuste de stock deshecho."));
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : t("Could not update the product.", "No se pudo actualizar el producto.");
      opts.setPageError(msg);
      throw error;
    }
  }

  async function requestProductDeletion(productId: string) {
    if (!businessId) return;
    const productName = opts.products.find((p) => p.id === productId)?.name ?? "";
    try {
      await executeDashboardAction("product.delete", { id: productId });

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("products");
      opts.appendChatHistoryEntry("success", t(`Done, I deleted the product "${productName}".`, `Listo, eliminé el producto "${productName}".`));

      opts.setUndoAction?.(async () => {
        await executeDashboardAction("undo.execute", { target: "product", productId });
        await loadBusiness({ silent: true, force: true }).catch(() => {});
        opts.appendChatHistoryEntry("success", t("Product restored.", "Producto restaurado."));
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : t("Could not delete the product.", "No se pudo eliminar el producto.");
      opts.setPageError(msg);
      throw error;
    }
  }

  return {
    updateProduct,
    requestProductDeletion,
  };
}
