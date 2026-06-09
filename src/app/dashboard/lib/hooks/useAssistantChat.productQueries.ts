"use client";

import type { VeloraSingleCommand } from "../command-parsers/shared";
import { buildProductPriceNotFoundReply, buildProductPriceReply } from "../command-parsers/product-price-query";
import { suggestProductMatch } from "../../../api/business-assistant/_lib/match-product-by-name";
import type { CommandLayerDispatchContext } from "./useAssistantChat.commandLayer";
import { emitConfirmationCard, emitTextReply, makeConfirmationId } from "./useAssistantChat.dispatchHelpers";
import { tLang } from "../DashboardLangContext";

// Extracted to keep useAssistantChat.commandLayer.ts under the 400-LOC
// ceiling. Handles check_stock and product_price_query, including the
// "¿Quisiste decir X?" fuzzy suggestion when catalog resolution fails.

type QueryCommand = Extract<VeloraSingleCommand, { intent: "check_stock" | "product_price_query" }>;

export async function handleProductQueryCommand(
  command: QueryCommand,
  rawTextForParser: string,
  ctx: CommandLayerDispatchContext,
): Promise<boolean> {
  if (command.intent === "check_stock") {
    if (command.data.productId) {
      const product = ctx.products.find((p) => p.id === command.data.productId);
      if (product) {
        return emitTextReply(ctx, rawTextForParser, () =>
          tLang(`${product.name} has ${product.stock} units in stock.`, `${product.name} tiene ${product.stock} unidades en stock.`)
        );
      }
    }
    const suggestion = suggestProductMatch(command.data.productName, ctx.products);
    if (suggestion) {
      return emitConfirmationCard(ctx, rawTextForParser, {
        id: makeConfirmationId(),
        severity: "warning",
        title: tLang("Did you mean another product?", "¿Quisiste decir otro producto?"),
        message: tLang(`"${command.data.productName}" not found. Did you mean "${suggestion.name}"?`, `No encontré "${command.data.productName}". ¿Quisiste decir "${suggestion.name}"?`),
        confirmLabel: tLang("Yes, that one", "Sí, ese"),
        cancelLabel: tLang("No", "No"),
        action: { type: "fuzzy_product_query", originalIntent: "check_stock", productId: suggestion.id, productName: suggestion.name },
      });
    }
    return emitTextReply(ctx, rawTextForParser, () =>
      tLang(`"${command.data.productName}" not found in your catalog. Check the name or add the product first.`, `No encontré "${command.data.productName}" en tu catálogo. Revisá el nombre o cargá el producto primero.`)
    );
  }

  // product_price_query
  if (command.data.productId) {
    const product = ctx.products.find((p) => p.id === command.data.productId);
    if (product) {
      return emitTextReply(ctx, rawTextForParser, () =>
        buildProductPriceReply(product.name, product.price, ctx.businessCurrency)
      );
    }
  }
  const suggestion = suggestProductMatch(command.data.productName, ctx.products);
  if (suggestion) {
    return emitConfirmationCard(ctx, rawTextForParser, {
      id: makeConfirmationId(),
      severity: "warning",
      title: tLang("Did you mean another product?", "¿Quisiste decir otro producto?"),
      message: tLang(`"${command.data.productName}" not found. Did you mean "${suggestion.name}"?`, `No encontré "${command.data.productName}". ¿Quisiste decir "${suggestion.name}"?`),
      confirmLabel: tLang("Yes, that one", "Sí, ese"),
      cancelLabel: tLang("No", "No"),
      action: { type: "fuzzy_product_query", originalIntent: "product_price_query", productId: suggestion.id, productName: suggestion.name },
    });
  }
  return emitTextReply(ctx, rawTextForParser, () =>
    buildProductPriceNotFoundReply(command.data.productName)
  );
}
