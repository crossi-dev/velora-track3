"use client";

import { useState } from "react";
import { executeDashboardAction } from "../actions/executeDashboardAction";
import { tLang } from "../DashboardLangContext";
import { buildAssistantCancellationMessage } from "../assistant-flow-chat";
import { acquireInFlight, releaseInFlight } from "../in-flight-lock";
import { drainNextPendingMessage } from "../pending-message-queue";
import { CHAT_EVENT } from "../chat-events";
import { classifyErrorForUser } from "./useAssistantChat.errors";
import type {
  AssistantConfirmationRequest,
  Product,
  PurchaseRequestRecord,
} from "../types";

interface UseAssistantConfirmationOptions {
  businessId?: string | null;
  products: Product[];
  deleteProduct: (id: string) => Promise<void>;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  refreshChatHistory?: () => void;
  setSuccessNotice: (msg: string | null) => void;
  setErrorNotice: (msg: string | null) => void;
  setAssistantReply: (msg: string | null) => void;
  appendChatHistoryEntry: (kind: "user" | "reply" | "success" | "error", text: string) => void;
  lastAssistantStockMovementIdsRef: React.RefObject<string[]>;
  setLatestPurchaseRequest?: (req: PurchaseRequestRecord | null) => void;
  t: (en: string, es: string) => string;
}

export function useAssistantConfirmation(opts: UseAssistantConfirmationOptions) {
  const {
    products,
    deleteProduct,
    loadBusiness,
    setSuccessNotice,
    setErrorNotice,
    setAssistantReply,
    appendChatHistoryEntry,
    lastAssistantStockMovementIdsRef,
    t,
  } = opts;

  const [assistantConfirmationRequest, setAssistantConfirmationRequest] = useState<AssistantConfirmationRequest | null>(null);
  const [assistantConfirmationError, setAssistantConfirmationError] = useState<string | null>(null);
  const [assistantConfirmationSubmitting, setAssistantConfirmationSubmitting] = useState(false);
  const [draftPriceValidated, setDraftPriceValidated] = useState(false);

  async function handleAssistantConfirmationConfirm() {
    if (!assistantConfirmationRequest || assistantConfirmationSubmitting) return;

    // Read-only query — no DB write, no lock needed
    if (assistantConfirmationRequest.action.type === "fuzzy_product_query") {
      const { action } = assistantConfirmationRequest;
      const product = products.find((p) => p.id === action.productId);
      let reply: string;
      if (action.originalIntent === "check_stock") {
        reply = product
          ? t(`${product.name} has ${product.stock} units in stock.`, `${product.name} tiene ${product.stock} unidades en stock.`)
          : t(`Could not find "${action.productName}" in the catalog.`, `No encontré "${action.productName}" en el catálogo.`);
      } else {
        const price = Number(product?.price ?? 0);
        reply = product
          ? t(`${product.name} costs $${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(price)}.`, `${product.name} sale a $${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(price)}.`)
          : t(`Could not find "${action.productName}" in the catalog.`, `No encontré "${action.productName}" en el catálogo.`);
      }
      setAssistantReply(reply);
      appendChatHistoryEntry("reply", reply);
      setAssistantConfirmationRequest(null);
      return;
    }

    if (!acquireInFlight(opts.businessId ?? null)) {
      setAssistantConfirmationError(t(
        "Hay otra acción en curso, probá en un segundo.",
        "Hay otra acción en curso, probá en un segundo.",
      ));
      return;
    }
    setAssistantConfirmationSubmitting(true);
    setAssistantConfirmationError(null);
    try {
      const { action } = assistantConfirmationRequest;
      let successMsg = t("Done.", "Listo, hecho.");
      if (action.type === "delete_product") {
        await deleteProduct(action.product.id);
        successMsg = t(`Done, I deleted "${action.product.name}".`, `Listo, eliminé "${action.product.name}".`);
      } else if (action.type === "multi_delete_product") {
        let succeeded = 0;
        const failed: string[] = [];
        for (const p of action.products) {
          try {
            await deleteProduct(p.id);
            succeeded++;
          } catch {
            failed.push(p.name);
          }
        }
        if (failed.length === 0) {
          successMsg = t(
            `Listo, eliminé ${succeeded} producto${succeeded === 1 ? "" : "s"}.`,
            `Listo, eliminé ${succeeded} producto${succeeded === 1 ? "" : "s"}.`,
          );
        } else if (succeeded === 0) {
          throw new Error(t(`Could not delete: ${failed.join(", ")}.`, `No pude eliminar: ${failed.join(", ")}.`));
        } else {
          successMsg = t(
            `Eliminé ${succeeded} producto${succeeded === 1 ? "" : "s"}. No pude eliminar: ${failed.join(", ")}.`,
            `Eliminé ${succeeded} producto${succeeded === 1 ? "" : "s"}. No pude eliminar: ${failed.join(", ")}.`,
          );
        }
      } else if (action.type === "adjust_stock") {
        // Use mode directly: "set" sends quantity as-is, "increase"/"decrease"
        // send the delta-applied value. Read current stock fresh from products
        // array (best available — server will apply atomically via updateMany).
        const currentStock = products.find(p => p.id === action.product.id)?.stock ?? 0;
        const newStock = action.mode === "set"
          ? action.quantity
          : action.mode === "increase"
            ? currentStock + action.quantity
            : Math.max(0, currentStock - action.quantity);
        await executeDashboardAction("stock.adjust", {
          id: action.product.id,
          stock: newStock,
          stockReason: "assistant_adjustment",
        });
        successMsg = t(`Done, I updated the stock for "${action.product.name}".`, `Listo, actualicé el stock de "${action.product.name}".`);
      } else if (action.type === "edit_product") {
        const parsed = Number.parseFloat(action.value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(t("Invalid price.", "Precio inválido."));
        }
        await executeDashboardAction("product.update", {
          id: action.product.id,
          price: parsed,
        });
        successMsg = t(
          `Listo, actualicé el precio de "${action.product.name}".`,
          `Listo, actualicé el precio de "${action.product.name}".`,
        );
      } else if (action.type === "update_business_profile") {
        const payload: Record<string, string | null> = {};
        if (action.field === "name") payload.name = action.value;
        else if (action.field === "phone") payload.phone = action.value;
        else if (action.field === "address") payload.address = action.value;
        else if (action.field === "email") payload.email = action.value;
        else if (action.field === "taxId") payload.cuit = action.value;
        else if (action.field === "openingTime") payload.openingTime = action.value;
        else if (action.field === "closingTime") payload.closingTime = action.value;
        await executeDashboardAction("business.update", payload);
        const labelMap: Record<"name" | "phone" | "address" | "email" | "taxId" | "openingTime" | "closingTime", string> = {
          name: "nombre",
          phone: "teléfono",
          address: "dirección",
          email: "email",
          taxId: "CUIT",
          openingTime: "horario de apertura",
          closingTime: "horario de cierre",
        };
        successMsg = t(
          `Listo, actualicé el ${labelMap[action.field]} del negocio.`,
          `Listo, actualicé el ${labelMap[action.field]} del negocio.`,
        );
      } else if (action.type === "create_budget") {
        const data = await executeDashboardAction("budget.create", {
          customerName: action.customerName,
          items: action.items.map((i) => ({
            productId: i.productId,
            name: i.name,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
          })),
        });
        const budgetNumber = (data as { budget?: { budgetNumber?: string } })?.budget?.budgetNumber;
        // autoSendWhatsapp parsed at command layer but server auto-send
        // requires the resolved customer phone, which we don't have
        // client-side here. Send-from-budget-view stays as the path for
        // now; extending this would require plumbing clients → confirmation ctx.
        const sendHint = action.autoSendWhatsapp
          ? t(" Open the quote and send it via WhatsApp from there.", " Abrí el presupuesto y enviálo por WhatsApp desde ahí.")
          : "";
        successMsg = budgetNumber
          ? t(`Quote ${budgetNumber} created.${sendHint}`, `Presupuesto ${budgetNumber} creado.${sendHint}`)
          : t(`Quote created.${sendHint}`, `Presupuesto creado.${sendHint}`);
      } else if (action.type === "add_contact") {
        if (action.kind === "customer") {
          await executeDashboardAction("customer.create", {
            businessId: opts.businessId ?? "",
            name: action.name,
            phone: action.phone,
            email: action.email,
            taxId: action.taxId,
          });
        } else {
          await executeDashboardAction("supplier.create", {
            businessId: opts.businessId ?? "",
            name: action.name,
            phone: action.phone,
            email: action.email,
            contactName: action.contactName,
          });
        }
        const kindLabel = action.kind === "customer" ? t("customer", "cliente") : t("supplier", "proveedor");
        successMsg = t(
          `Done, I created the ${kindLabel} "${action.name}".`,
          `Listo, creé el ${kindLabel} "${action.name}".`,
        );
      } else if (action.type === "create_product") {
        await executeDashboardAction("product.create", {
          businessId: opts.businessId ?? "",
          name: action.product.name,
          price: action.product.price,
          stock: action.product.stock,
        });
        successMsg = t(
          `Listo, creé el producto "${action.product.name}".`,
          `Listo, creé el producto "${action.product.name}".`,
        );
      } else if (action.type === "update_invoice_status") {
        await executeDashboardAction("invoice.update-status", {
          invoiceId: action.invoice.id,
          status: action.status,
        });
        const statusLabel: Record<typeof action.status, string> = {
          issued: "emitida",
          sent: "enviada",
          paid: "pagada",
        };
        successMsg = t(
          `Factura ${action.invoice.invoiceNumber} marcada como ${statusLabel[action.status]}.`,
          `Factura ${action.invoice.invoiceNumber} marcada como ${statusLabel[action.status]}.`,
        );
      } else if (action.type === "create_product_and_retry_sale") {
        // Voice-trained catalog flow: resolve-or-create handles the race
        // when two concurrent retries hit the same product name (P2002 →
        // re-resolve transparently). The `resolved` flag tells us whether
        // the catalog already had the product (case/accent-normalized
        // match the chat parser missed) so the success message stays honest.
        const data = await executeDashboardAction("product.resolve-or-create", {
          name: action.product.name,
          price: action.product.price,
        });
        const verb = data.resolved ? "encontré" : "creé";
        successMsg = t(
          `Listo, ${verb} "${data.product.name}". Completando la venta…`,
          `Listo, ${verb} "${data.product.name}". Completando la venta…`,
        );
        // Retry dispatch is deferred to the post-loadBusiness block below
        // so it sequences AFTER ctx.products has the fresh entry. A prior
        // setTimeout(400ms) approach raced loadBusiness and produced an
        // infinite confirmation loop when the reload exceeded the timer.
      } else if (action.type === "bulk_price_update") {
        const data = await executeDashboardAction("product.bulk-price-update", {
          amount: action.amount,
          mode: action.mode,
          direction: action.direction,
          productIds: action.productIds,
        });
        successMsg = data.summary || t(
          `${data.updated} precios actualizados.`,
          `${data.updated} precios actualizados.`
        );
      } else if (action.type === "register_movement") {
        await executeDashboardAction("cash-movement.create", {
          type: action.movement.movementType,
          amount: action.movement.amount,
          description: action.movement.description,
        });
        successMsg = t("Listo, registré el movimiento.", "Listo, registré el movimiento.");
      } else if (action.type === "create_purchase_request") {
        const data = await executeDashboardAction("purchase-request.create", {
          supplierName: action.supplierName,
          itemName: action.itemName,
          // null means owner did not specify; default to 1 so the server-side
          // normalizePurchaseRequestCreateInput guard (parsePositiveInteger)
          // always receives a valid value.
          quantity: action.quantity ?? 1,
          unitPrice: action.unitPrice,
        });
        successMsg = t(
          `Listo, armé el pedido #${data.requestNumber}.`,
          `Listo, armé el pedido #${data.requestNumber}.`,
        );
        opts.setLatestPurchaseRequest?.({
          id: data.id,
          requestNumber: data.requestNumber,
          issuedAt: new Date().toISOString(),
          currency: "ARS",
          totalAmount: 0,
          payload: null,
        });
      } else if (action.type === "register_sale_with_new_customer") {
        // Step 1: create or return existing customer.
        // createCustomerInTransaction checks by phone first (true upsert-by-phone
        // when phone is present), then falls back to name-uniqueness guard.
        // Idempotency for double-tap is enforced by the X-Idempotency-Key header;
        // the phone check prevents duplicate records when two different keys are sent.
        const customerResult = await executeDashboardAction("customer.create", {
          businessId: opts.businessId ?? "",
          name: action.newCustomer.name,
          phone: action.newCustomer.phone,
        });
        const customerId = customerResult.customer?.id;
        if (!customerId) {
          throw new Error(t("Could not create the customer. Try again.", "No pude crear el cliente. Intentá de nuevo."));
        }
        // Step 2: register the sale with the new customerId.
        // saleItems/saleTotal were embedded by the server at confirmation-card
        // build time — no second /api/parse-sale round-trip needed.
        if (!action.saleItems?.length || !action.saleTotal) {
          throw new Error(t("Sale data missing. Try dictating the sale again.", "Faltan datos de la venta. Dictala de nuevo."));
        }
        await executeDashboardAction("sale.create", {
          businessId: opts.businessId ?? "",
          customerId,
          items: action.saleItems,
          total: action.saleTotal,
        });
        successMsg = t(
          `Sale registered for ${action.newCustomer.name}.`,
          `Venta registrada para ${action.newCustomer.name}.`,
        );
      } else if (action.type === "undo") {
        const anchoredIds = action.undoTarget === "stock"
          && lastAssistantStockMovementIdsRef.current.length > 0
          && lastAssistantStockMovementIdsRef.current.length >= action.undoCount
          ? lastAssistantStockMovementIdsRef.current.slice(0, action.undoCount)
          : undefined;
        const data = await executeDashboardAction("undo.execute", {
          target: action.undoTarget,
          count: action.undoCount,
          ...(anchoredIds ? { stockMovementIds: anchoredIds } : {}),
        });
        const summaryLines = Array.isArray((data as { summary?: unknown }).summary)
          ? (data as { summary: string[] }).summary
          : [];
        successMsg = summaryLines.length > 0
          ? tLang(`Done, the action was undone.\n${summaryLines.join(", ")}`, `Listo, se deshizo la acción.\n${summaryLines.join(", ")}`)
          : tLang("Done, the action was undone.", "Listo, se deshizo la acción.");
      }
      setAssistantConfirmationRequest(null);
      setSuccessNotice(successMsg);
      setErrorNotice(null);
      setAssistantReply(null);
      appendChatHistoryEntry("success", successMsg);
      try {
        await loadBusiness({ silent: true, force: true });
        // Voice-trained catalog flow (Flujo 1): retry dispatch sequences
        // AFTER loadBusiness so ctx.products has the just-resolved/created
        // entry. requestAnimationFrame defers until React commits the
        // re-render, so handleGoRef.current points to a closure with the
        // fresh products list. Without this, the listener would call
        // handleGo with stale products → parser misses → confirmation card
        // re-opens → infinite loop. If loadBusiness throws (catch below),
        // we deliberately skip the dispatch — stale catalog would loop.
        if (action.type === "create_product_and_retry_sale" && typeof window !== "undefined") {
          const saleText = action.retrySaleText;
          requestAnimationFrame(() => {
            try {
              window.dispatchEvent(
                new CustomEvent(CHAT_EVENT.RETRY_SALE, { detail: { saleText } }),
              );
            } catch {
              /* non-browser runtime */
            }
          });
        }
      } catch (reloadErr) {
        console.warn("[useAssistantConfirmation] loadBusiness reload failed", reloadErr);
        setSuccessNotice(t(
          "La acción se completó pero no pude actualizar el panel — recargá manualmente.",
          "La acción se completó pero no pude actualizar el panel — recargá manualmente.",
        ));
        setErrorNotice(null);
      }
      opts.refreshChatHistory?.();
    } catch (e) {
      // Keep the modal open so the user can retry without re-typing.
      // The error is shown inline in the modal footer; the card stays mounted.
      const rawMsg = e instanceof Error ? e.message : t("Could not complete this action.", "No pude completar esta acción.");
      const userMsg = classifyErrorForUser(rawMsg, undefined, t).message;
      setAssistantConfirmationError(userMsg);
    } finally {
      setAssistantConfirmationSubmitting(false);
      releaseInFlight(opts.businessId ?? null);
      // Confirmation flow held the in-flight lock — any messages the user
      // sent during execution were enqueued by handleGo's cross-hook
      // branch. Drain one now; if more remain, each subsequent handleGo
      // finally will keep draining.
      drainNextPendingMessage();
    }
  }

  function handleAssistantConfirmationCancel() {
    appendChatHistoryEntry("reply", buildAssistantCancellationMessage("confirmation"));
    setAssistantConfirmationRequest(null);
    setAssistantConfirmationError(null);
    setAssistantReply(null);
  }

  return {
    assistantConfirmationRequest, setAssistantConfirmationRequest,
    assistantConfirmationError, setAssistantConfirmationError,
    assistantConfirmationSubmitting, setAssistantConfirmationSubmitting,
    draftPriceValidated, setDraftPriceValidated,
    handleAssistantConfirmationConfirm,
    handleAssistantConfirmationCancel,
  };
}
