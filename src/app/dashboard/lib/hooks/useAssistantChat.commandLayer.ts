"use client";

import type { VeloraSingleCommand } from "../command-parsers/shared";
import type { CommandLayerDispatchContext } from "./useAssistantChat.dispatchHelpers";
export type { CommandLayerDispatchContext } from "./useAssistantChat.dispatchHelpers";
import { tLang } from "../DashboardLangContext";
import { buildEditProductConfirmMessage } from "../command-parsers/edit-product";
import { buildPriceIntentFallbackReply } from "../command-parsers/price-intent-fallback";
// buildCreateProductConfirmMessage: import removed 2026-05-30 (create_product L0 dispatch removed).
import { handleAddContactCommand } from "./useAssistantChat.addContact";
import { handleCreateBudgetCommand } from "./useAssistantChat.createBudget";
// buildRegisterMovementConfirmMessage: import removed 2026-05-30 (register_movement L0 dispatch removed).

import { buildUpdateBusinessProfileConfirmMessage } from "../command-parsers/update-business-profile";
import { buildUpdateInvoiceStatusConfirmMessage, resolveInvoiceByQuery } from "../command-parsers/update-invoice-status";
import { handleRegisterSaleCommand } from "./useAssistantChat.registerSale";
import { emitConfirmationCard, emitTextReply, makeConfirmationId, resolveLiveProduct } from "./useAssistantChat.dispatchHelpers";

/**
 * Dispatches a matched Command-Layer intent. Returns `true` if the intent
 * was handled locally (caller should short-circuit `handleGo` with
 * `return`). Returns `false` if no branch matched / resolved and the
 * caller should fall through to the AI path.
 */
export async function dispatchCommandLayerIntent(
  command: VeloraSingleCommand,
  rawTextForParser: string,
  ctx: CommandLayerDispatchContext
): Promise<boolean> {
  // ── register_sale ───────────────────────────────────────────
  // Body extracted to useAssistantChat.registerSale.ts (longest branch
  // in the dispatcher — kept this file under the 400-LOC ceiling once
  // find_customer shipped). Returns false → fall through to AI.
  if (command.intent === "register_sale") {
    const handled = await handleRegisterSaleCommand(command, rawTextForParser, ctx);
    if (handled) return true;
  }

  // QUERY INTENTS — fall through to LLM.
  //
  // check_stock, inventory_list, cash_balance, sales_summary,
  // low_stock_query, find_customer, product_price_query — all read-only
  // queries. They used to dispatch locally with regex parsers (2018-era
  // Rasa pattern). Now they fall through to Gemini Flash on the server,
  // where the prompt + post-handler safety net produce better answers
  // without per-phrasing detector chase. The parsers + handlers remain
  // exported (still tested directly) so they can be re-enabled if a
  // specific query proves too slow over LLM. KEEP destructive branches
  // below — money path stays deterministic.

  // ── stock_load ─────────────────────────────────────────────
  // L0 dispatch removed 2026-05-30 (OA Phase 4 cleanup).
  // OA (USE_OWNER_ASSISTANT=true) now owns stock_load via stock_load tool.
  // Falls through to server-side OA / Supervisor.

  // ── edit_product ───────────────────────────────────────────
  // Single-product price update gated behind a confirmation card.
  // Falls through to AI on null catalog resolution (shared guard).
  if (command.intent === "edit_product") {
    const product = resolveLiveProduct(ctx, command.data.productId);
    if (!product) return false;
    const message = buildEditProductConfirmMessage(product.name, command.data.newPrice, ctx.businessCurrency);
    return emitConfirmationCard(ctx, rawTextForParser, {
      id: makeConfirmationId(),
      severity: "warning",
      title: tLang("Confirm price update", "Confirmar actualización de precio"),
      message,
      confirmLabel: tLang("Confirm", "Confirmar"),
      cancelLabel: tLang("Cancel", "Cancelar"),
      action: {
        type: "edit_product",
        product: { id: product.id, name: product.name },
        field: "price",
        value: String(command.data.newPrice),
      },
    });
  }

  // ── stock_adjustment ───────────────────────────────────────
  // L0 dispatch removed 2026-05-30 (OA Phase 4 cleanup).
  // OA (USE_OWNER_ASSISTANT=true) now owns adjust_stock via adjust_stock tool.
  // Falls through to server-side OA / Supervisor.

  // ── bulk_price_update ──────────────────────────────────────
  // L0 dispatch removed 2026-05-30 (OA Phase 4 cleanup).
  // OA (USE_OWNER_ASSISTANT=true) now owns bulk_price_update via bulk_price_update tool.
  // Falls through to server-side OA / Supervisor.

  // ── price_intent_fallback ──────────────────────────────────
  // Multi-price update detected but no product names resolved
  // (typically STT mangling). Ask the user to repeat with
  // catalog names rather than dropping through to the AI.
  if (command.intent === "price_intent_fallback") {
    return emitTextReply(ctx, rawTextForParser, buildPriceIntentFallbackReply);
  }

  // ── create_product_from_voice ──────────────────────────────
  // User replied with a price to "No conozco 'X'. ¿Cuál es el precio?".
  // Confirmation card creates the product; the confirmation handler
  // retries the original sale once the catalog has the new item.
  if (command.intent === "create_product_from_voice") {
    const fmt = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: ctx.businessCurrency || "ARS",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    const message = tLang(`Create "${command.data.productName}" at ${fmt.format(command.data.price)} and complete the sale?`, `¿Crear "${command.data.productName}" a ${fmt.format(command.data.price)} y completar la venta?`);
    return emitConfirmationCard(ctx, rawTextForParser, {
      id: makeConfirmationId(),
      severity: "warning",
      title: tLang("Confirm new product", "Confirmar nuevo producto"),
      message,
      confirmLabel: tLang("Confirm", "Confirmar"),
      cancelLabel: tLang("Cancel", "Cancelar"),
      action: {
        type: "create_product_and_retry_sale",
        product: { name: command.data.productName, price: command.data.price },
        retrySaleText: command.data.retrySaleText,
      },
    });
  }

  // ── create_budget (body in useAssistantChat.createBudget.ts) ──
  if (command.intent === "create_budget") {
    return handleCreateBudgetCommand(command, rawTextForParser, ctx);
  }

  // ── add_contact (body in useAssistantChat.addContact.ts) ──
  // Customer kind (add_contact kind=customer) L0 dispatch removed 2026-05-30
  // (OA Phase 4 cleanup). OA now owns create_customer. Supplier kind kept —
  // create_supplier has no OA fast-path yet (OA Phase 3 claim handles the server
  // side, but supplier edit/delete still relies on Supervisor delegation).
  if (command.intent === "add_contact" && command.data.kind === "supplier") {
    return handleAddContactCommand(command, rawTextForParser, ctx);
  }

  // ── create_product ─────────────────────────────────────────
  // L0 dispatch removed 2026-05-30 (OA Phase 4 cleanup).
  // OA (USE_OWNER_ASSISTANT=true) now owns create_product via create_product tool.
  // Falls through to server-side OA / Supervisor.

  // ── update_business_profile ────────────────────────────────
  // Single-field update (name/phone/address/email/taxId) for the
  // current business. Confirmation card → business.update.
  if (command.intent === "update_business_profile") {
    const message = buildUpdateBusinessProfileConfirmMessage(command.data);
    return emitConfirmationCard(ctx, rawTextForParser, {
      id: makeConfirmationId(),
      severity: "warning",
      title: tLang("Confirm profile update", "Confirmar cambio de perfil"),
      message,
      confirmLabel: tLang("Confirm", "Confirmar"),
      cancelLabel: tLang("Cancel", "Cancelar"),
      action: {
        type: "update_business_profile",
        field: command.data.field,
        value: command.data.value,
      },
    });
  }

  // ── update_invoice_status ──────────────────────────────────
  // Resolve the invoice query against ctx.invoices; fall through if
  // nothing matches or the match is ambiguous (multiple substring hits).
  // The useAssistantConfirmation branch handles update_invoice_status
  // → invoice.update-status action on Confirmar.
  if (command.intent === "update_invoice_status") {
    const invoice = resolveInvoiceByQuery(command.data.invoiceNumberQuery, ctx.invoices);
    if (!invoice) return false;
    const message = buildUpdateInvoiceStatusConfirmMessage(invoice.invoiceNumber, command.data.status);
    return emitConfirmationCard(ctx, rawTextForParser, {
      id: makeConfirmationId(),
      severity: "warning",
      title: tLang("Confirm invoice status", "Confirmar estado de factura"),
      message,
      confirmLabel: tLang("Confirm", "Confirmar"),
      cancelLabel: tLang("Cancel", "Cancelar"),
      action: {
        type: "update_invoice_status",
        invoice: { id: invoice.id, invoiceNumber: invoice.invoiceNumber },
        status: command.data.status,
      },
    });
  }

  // ── register_movement ──────────────────────────────────────
  // L0 dispatch removed 2026-05-30 (OA Phase 4 cleanup).
  // OA (USE_OWNER_ASSISTANT=true) now owns register_movement via register_movement tool.
  // Falls through to server-side OA / Supervisor.

  return false;
}
