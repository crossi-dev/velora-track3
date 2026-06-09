import { toErrorMessage, buildEditProductReply } from "../assistant-chat-utils";
import { executeDashboardAction } from "../../actions/executeDashboardAction";
import type { Product } from "../../types";
import type { ActionHandlerArgs } from "./types";

export async function handleEditProduct({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const product = action.product as { id: string; name: string };
    const field = action.field as string;
    const value = action.value as string;
    // id may be "" when not in snapshot — fall back to name lookup
    const resolved = product.id
      ? (ctx.products as Product[]).find((p) => p.id === product.id) ?? product
      : (ctx.products as Product[]).find((p) => p.name.toLowerCase() === product.name.toLowerCase());
    if (!resolved?.id) throw new Error(ctx.t(`Could not find product "${product.name}".`, `No encontré el producto "${product.name}".`));
    const patch: Partial<Product> = {};
    if (field === "name") patch.name = value;
    else if (field === "price") patch.price = parseFloat(value);
    else if (field === "costPrice") patch.costPrice = parseFloat(value);
    else (patch as Record<string, unknown>).sku = value;
    await ctx.updateProduct(resolved.id, patch);
    const reply = buildEditProductReply(field, resolved.name, value, ctx.t);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not update the product.", "No se pudo actualizar el producto."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleCreateProduct({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const product = action.product as { name: string; price: number; stock: number };
    await executeDashboardAction("product.create", {
      businessId: ctx.businessId ?? "",
      name: product.name,
      price: product.price,
      stock: product.stock ?? 0,
    });
    const reply = ctx.t(`Done, I created the product "${product.name}".`, `Listo, creé el producto "${product.name}".`);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not create the product. Check the name and price.", "No pude crear el producto. Verificá nombre y precio."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleDeleteProduct({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  const product = action.product as { id: string; name: string };
  // id may be "" when not in snapshot — fall back to name lookup
  const resolved = product.id
    ? product
    : (ctx.products as Product[]).find((p) => p.name.toLowerCase() === product.name.toLowerCase());
  if (!resolved?.id) {
    const errMsg = ctx.t(`Could not find product "${product.name}".`, `No encontré el producto "${product.name}".`);
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
    return true;
  }
  const message = ctx.t(
    `Are you sure you want to delete "${resolved.name}"? This cannot be undone.`,
    `¿Confirmás eliminar "${resolved.name}"? Esta acción no se puede deshacer.`,
  );
  ctx.setAssistantReply(message);
  ctx.setAssistantConfirmationRequest({
    id: crypto.randomUUID(),
    severity: "critical",
    title: ctx.t("Delete product", "Eliminar producto"),
    message,
    confirmLabel: ctx.t("Delete", "Eliminar"),
    cancelLabel: ctx.t("Cancel", "Cancelar"),
    action: { type: "delete_product", product: { id: resolved.id, name: resolved.name } },
  });
  return true;
}

export async function handleBulkPriceUpdate({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const amount = Number(action.amount ?? 0);
    const mode = String(action.mode ?? "percentage") as "percentage" | "absolute";
    const direction = String(action.direction ?? "up") as "up" | "down" | "set";
    const targetLabel = String(action.targetLabel ?? "").toLowerCase().trim();
    const isAll = !targetLabel || targetLabel === "all" || targetLabel === "todos" || targetLabel === "todos los productos";
    // Prefer exact match to avoid hitting "pasta base" when target is "pasta"
    const productIds: string[] = isAll
      ? []
      : (() => {
          const allProds = ctx.products as Product[];
          const exact = allProds.filter((p) => p.name.toLowerCase() === targetLabel);
          if (exact.length > 0) return exact.map((p) => p.id);
          return allProds
            .filter((p) => p.name.toLowerCase().includes(targetLabel) || targetLabel.includes(p.name.toLowerCase()))
            .map((p) => p.id);
        })();
    await executeDashboardAction("product.bulk-price-update", { amount, mode, direction, productIds });
    const count = isAll ? (ctx.products as Product[]).length : productIds.length;
    const reply = ctx.t(`Done, I updated ${count} price${count !== 1 ? "s" : ""}.`, `Listo, actualicé ${count} precio${count !== 1 ? "s" : ""}.`);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not update the prices. Try again.", "No pude actualizar los precios. Intentá de nuevo."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleMultiEditProduct({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const edits = Array.isArray(action.edits) ? action.edits as Array<{ productName: string; field: string; value: number }> : [];
    let successCount = 0;
    for (const edit of edits) {
      const name = typeof edit.productName === "string" ? edit.productName.trim() : "";
      const value = Number(edit.value);
      if (!name || !Number.isFinite(value)) continue;
      const matched = ctx.products.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (matched) {
        // Allowlist: only "price" and "costPrice" are valid edit fields.
        // Silently skip unexpected fields to avoid mutating the wrong column.
        if (edit.field !== "price" && edit.field !== "costPrice") continue;
        const field: "price" | "costPrice" = edit.field;
        await ctx.updateProduct(matched.id, { [field]: value });
        successCount++;
      }
    }
    if (successCount === 0) {
      const errMsg = ctx.t("Could not find the products to update. Check the names.", "No encontré los productos para actualizar. Verificá los nombres.");
      ctx.setAssistantReply(errMsg);
      ctx.appendChatHistoryEntry("error", errMsg);
    } else {
      const reply = ctx.t(`Done, I updated ${successCount} price${successCount > 1 ? "s" : ""}.`, `Listo, actualicé ${successCount} precio${successCount > 1 ? "s" : ""}.`);
      ctx.setAssistantReply(reply);
      ctx.appendDurableReply(reply);
      await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
    }
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not update the prices.", "No pude actualizar los precios."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}
