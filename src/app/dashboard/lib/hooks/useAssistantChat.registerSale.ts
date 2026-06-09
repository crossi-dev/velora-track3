"use client";

import type { VeloraSingleCommand } from "../command-parsers/shared";
import type { ParsedSale } from "../types";
import type { CommandLayerDispatchContext } from "./useAssistantChat.dispatchHelpers";
import {
  buildDuplicateAttemptWarning,
  buildDuplicateSaleWarning,
  findRecentAttemptDuplicate,
  findRecentDuplicateSale,
  recordSaleAttempt,
} from "../sale-duplicate-detection";
import { detectPriceOutlier, detectStockShortfall, DEFAULT_PRICE_OUTLIER_THRESHOLD } from "@/domain/rules";
import { getAppSettings } from "../appSettings";
import { tLang } from "../DashboardLangContext";
import {
  buildUnknownProductQuestion,
  setPendingUnknownProduct,
} from "../unknown-product-flow";
import { emitConfirmationCard, makeConfirmationId } from "./useAssistantChat.dispatchHelpers";

/**
 * Handles the register_sale intent branch extracted from the main
 * Command Layer dispatcher to keep useAssistantChat.commandLayer.ts
 * under the 400-LOC ceiling. Pure code movement — behavior identical
 * to the previous inline branch.
 *
 * Returns `true` if the sale was fully resolved and dispatched; `false`
 * to signal the dispatcher should continue trying other intents
 * (e.g. a product in the sale didn't resolve → fall through to AI).
 */
export async function handleRegisterSaleCommand(
  command: Extract<VeloraSingleCommand, { intent: "register_sale" }>,
  rawTextForParser: string,
  ctx: CommandLayerDispatchContext
): Promise<boolean> {
  if (command.data.ambiguousCustomer || command.data.items.length === 0) {
    // Surface a transient hint so the user sees feedback during the
    // ~700ms hand-off to the AI fallback.
    ctx.appendTransientReply(tLang("Processing…", "Procesando…"));
    return false;
  }
  const allowNegativeStock = getAppSettings().allowNegativeStock;
  const resolvedItems = command.data.items.map((item) => {
    if (!item.productId) return null;
    const product = ctx.products.find((p) => p.id === item.productId);
    if (!product) return null;
    const unitPrice = item.unitPrice ?? Number(product.price ?? 0);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;
    const catalogPrice = Number(product.price ?? 0);
    const priceOutlier = item.unitPrice !== null
      ? detectPriceOutlier(item.unitPrice, catalogPrice, DEFAULT_PRICE_OUTLIER_THRESHOLD) ?? undefined
      : undefined;
    const stockShortfall = (!allowNegativeStock ? detectStockShortfall(item.quantity, product.stock) : null) ?? undefined;
    return {
      productId: product.id,
      productName: product.name,
      quantity: item.quantity,
      unitPrice,
      subtotal: unitPrice * item.quantity,
      priceOutlier,
      stockShortfall,
    };
  });
  const allResolved = resolvedItems.every((item) => item !== null);
  if (!allResolved) {
    // Voice-trained catalog flow: for any number of unresolved items,
    // address them one at a time. Each iteration asks for (or confirms)
    // the first unknown product; after it is created the sale retries
    // and the next unknown is picked up in the same way.
    const unresolvedIndices = resolvedItems
      .map((item, idx) => (item === null ? idx : -1))
      .filter((i) => i !== -1);
    if (unresolvedIndices.length >= 1) {
      const unknownItem = command.data.items[unresolvedIndices[0]];
      if (unknownItem?.productName && unknownItem.productName.length >= 2) {
        // Price already provided in the sale phrase (e.g. "vendí flan casero a 300"):
        // skip the question and go straight to the confirmation card.
        if (unknownItem.unitPrice !== null && unknownItem.unitPrice > 0) {
          const fmt = new Intl.NumberFormat("es-AR", {
            style: "currency",
            currency: ctx.businessCurrency || "ARS",
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          });
          const message = tLang(`Create "${unknownItem.productName}" at ${fmt.format(unknownItem.unitPrice)} and complete the sale?`, `¿Crear "${unknownItem.productName}" a ${fmt.format(unknownItem.unitPrice)} y completar la venta?`);
          return emitConfirmationCard(ctx, rawTextForParser, {
            id: makeConfirmationId(),
            severity: "warning",
            title: tLang("Confirm new product", "Confirmar nuevo producto"),
            message,
            confirmLabel: tLang("Confirm", "Confirmar"),
            cancelLabel: tLang("Cancel", "Cancelar"),
            action: {
              type: "create_product_and_retry_sale",
              product: { name: unknownItem.productName, price: unknownItem.unitPrice },
              retrySaleText: rawTextForParser,
            },
          });
        }
        setPendingUnknownProduct({
          productName: unknownItem.productName,
          saleText: rawTextForParser,
        });
        ctx.appendChatHistoryEntry("user", rawTextForParser);
        ctx.setInput("");
        const question = buildUnknownProductQuestion(unknownItem.productName);
        ctx.setAssistantReply(question);
        ctx.appendDurableReply(question);
        return true;
      }
    }
    return false;
  }

  ctx.appendChatHistoryEntry("user", rawTextForParser);
  ctx.setInput("");
  const customerId = command.data.customerId ?? "";
  const customerName = command.data.customerId
    ? ctx.clients.find((c) => c.id === command.data.customerId)?.name ?? command.data.customerName ?? "Consumidor Final"
    : "Consumidor Final";
  const items = resolvedItems as NonNullable<(typeof resolvedItems)[number]>[];
  for (const item of items) {
    // Validate directly against the original value to catch fractional quantities
    // (e.g. 1.5) that parseInt would silently truncate to 1 and pass validation.
    const qty = item.quantity;
    if (!Number.isInteger(qty) || qty <= 0) {
      ctx.setAssistantReply(tLang("Could not register sale: quantity must be a positive integer.", "No se pudo registrar la venta: la cantidad debe ser un número entero mayor a cero."));
      return true;
    }
    const price = parseFloat(String(item.unitPrice));
    if (!Number.isFinite(price) || price <= 0) {
      ctx.setAssistantReply(tLang("Could not register sale: unit price must be a positive number.", "No se pudo registrar la venta: el precio unitario debe ser un número mayor a cero."));
      return true;
    }
  }
  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  const draft: ParsedSale = {
    customer: { id: customerId, name: customerName },
    items,
    total,
  };
  // Duplicate-sale safety net: same customerId + same item multiset
  // within 60s. Two sources are consulted because ctx.sales refreshes
  // asynchronously via loadBusiness after a commit — by the time the
  // user retypes the same phrase seconds later, the server-persisted
  // list hasn't caught up. The in-memory attempt buffer closes that gap.
  //
  // When a duplicate is found we degrade autoSendWhatsapp to a manual
  // draft so the user sees the warning and re-confirms instead of
  // firing a second WhatsApp silently.
  const nowMs = Date.now();
  const candidate = {
    customerId: command.data.customerId,
    items: command.data.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
  };
  const committedDuplicate = findRecentDuplicateSale(ctx.sales, candidate, nowMs);
  const attemptDuplicate = committedDuplicate ? null : findRecentAttemptDuplicate(candidate, nowMs);

  if (committedDuplicate || attemptDuplicate) {
    await ctx.dispatchSaleAction("sale.draft.open", { draft, source: "assistant" });
    const warning = committedDuplicate
      ? buildDuplicateSaleWarning(committedDuplicate, nowMs)
      : buildDuplicateAttemptWarning(nowMs - attemptDuplicate!.timestamp);
    ctx.appendTransientReply(warning);
    recordSaleAttempt(candidate, nowMs);
    return true;
  }

  const customerPhone = command.data.customerId
    ? (ctx.clients.find((c) => c.id === command.data.customerId)?.phone ?? "")
    : "";
  if (command.data.autoSendWhatsapp && customerPhone) {
    await ctx.dispatchSaleAction("sale.draft.cancel", { emitChatMessage: false });
    await ctx.dispatchSaleAction("sale.confirm-and-send-whatsapp", { draftOverride: draft });
  } else {
    if (command.data.autoSendWhatsapp && !customerPhone) {
      ctx.appendTransientReply(tLang("I don't have a WhatsApp number for this customer. Register the sale and then add the phone number from Contacts.", "No tengo número de WhatsApp para este cliente. Registrá la venta y luego agregá el teléfono desde Clientes."));
    }
    await ctx.dispatchSaleAction("sale.draft.open", { draft, source: "assistant" });
    ctx.appendTransientReply(tLang("Sale detected. Review the draft and confirm.", "Venta detectada. Revisá el borrador y confirmá."));
  }
  recordSaleAttempt(candidate, nowMs);
  return true;
}
