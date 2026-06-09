"use client";

import {
  buildMutationHeaders,
  clearMutationKey,
  createMutationSignature,
  fetchWithTimeout,
  getSafeJson,
} from "../hooks/utils";
import type { ActionKey, ActionPayload, ActionResult } from "./contracts";
import { tryQueueOfflineAction } from "./offline-action-queue";
import { tLang } from "../DashboardLangContext";

function fallbackErrorForAction(action: ActionKey) {
  switch (action) {
    case "sale.create":
      return tLang("Could not save the sale.", "No se pudo guardar la venta.");
    case "stock.adjust":
      return tLang("Could not adjust the stock.", "No se pudo ajustar el stock.");
    case "stock-load.create":
      return tLang("Could not save the inventory load.", "No se pudo guardar la carga de inventario.");
    case "cash-movement.create":
      return tLang("Could not save the cash movement.", "No se pudo guardar el movimiento de caja.");
    case "product.create":
      return tLang("Could not create the product.", "No se pudo crear el producto.");
    case "product.update":
      return tLang("Could not update the product.", "No se pudo actualizar el producto.");
    case "product.delete":
      return tLang("Could not delete the product.", "No se pudo eliminar el producto.");
    case "product.resolve-or-create":
      return tLang("Could not resolve the product.", "No se pudo resolver el producto.");
    case "customer.create":
      return tLang("Could not create the customer.", "No se pudo crear el cliente.");
    case "customer.update":
      return tLang("Could not update the customer.", "No se pudo actualizar el cliente.");
    case "customer.delete":
      return tLang("Could not delete the customer.", "No se pudo eliminar el cliente.");
    case "supplier.create":
      return tLang("Could not create the supplier.", "No se pudo crear el proveedor.");
    case "supplier.update":
      return tLang("Could not update the supplier.", "No se pudo actualizar el proveedor.");
    case "supplier.delete":
      return tLang("Could not delete the supplier.", "No se pudo eliminar el proveedor.");
    case "invoice.update-status":
      return tLang("Could not update the invoice.", "No se pudo actualizar la factura.");
    case "invoice.send-whatsapp":
      return tLang("Could not send the invoice via WhatsApp. Check the number with country code (e.g. +54911...).", "No se pudo enviar la factura por WhatsApp. Verificá el número con prefijo de país (ej: +54911...).");
    case "product.bulk-price-update":
      return tLang("Could not update the prices.", "No se pudo actualizar los precios.");
    case "business.update":
      return tLang("Could not save the configuration.", "No se pudo guardar la configuración.");
    case "undo.execute":
      return tLang("Could not undo the action.", "No se pudo deshacer la acción.");
    case "purchase-request.create":
      return tLang("Could not create the purchase request.", "No se pudo crear el pedido de compra.");
    case "purchase-request.send-whatsapp":
      return tLang("Could not send the purchase request via WhatsApp. Check the number with country code (e.g. +54911...).", "No se pudo enviar la solicitud de compra por WhatsApp. Verificá el número con prefijo de país (ej: +54911...).");
    case "budget.create":
      return tLang("Could not create the budget.", "No se pudo crear el presupuesto.");
    case "budget.delete":
      return tLang("Could not delete the budget.", "No se pudo eliminar el presupuesto.");
    case "budget.send-whatsapp":
      return tLang("Could not send the budget via WhatsApp. Check the number with country code (e.g. +54911...).", "No se pudo enviar el presupuesto por WhatsApp. Verificá el número con prefijo de país (ej: +54911...).");
    case "push-notifications.subscribe":
      return tLang("Could not register the subscription.", "No se pudo registrar la suscripción.");
    default:
      return tLang("Could not complete the action.", "No se pudo completar la acción.");
  }
}

async function executeMutationRequest<K extends ActionKey>(
  action: K,
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  payload: ActionPayload<K>,
  body: unknown = payload
) {
  const signature = createMutationSignature(action, payload);
  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers: buildMutationHeaders(signature),
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
    });
    const data = await getSafeJson<ActionResult<K>>(response, fallbackErrorForAction(action));
    return data;
  } finally {
    // Always clear the mutation key — prevents stuck retries when server
    // succeeds but response parsing fails (e.g. malformed JSON from proxy)
    clearMutationKey(signature);
  }
}

export async function executeDashboardAction<K extends ActionKey>(
  action: K,
  payload: ActionPayload<K>
): Promise<ActionResult<K>> {
  // Dead Man's Switch — si el browser está offline + el action es elegible
  // + el feature flag está ON, encolamos en localStorage y retornamos
  // ActionResult sintético. El drain (useOfflineQueueDrain) re-dispatcha
  // al endpoint cuando vuelve la conexión. Feature flag se re-lee en cada
  // call (no module-load capture) — toggle DevTools toma efecto sin reload.
  const queued = tryQueueOfflineAction(action, payload);
  if (queued !== null) return queued;

  switch (action) {
    case "sale.create": {
      // Strict schema rejects: businessId/allowNegativeStock (not in schema)
      // and `null` for customerId/locale (CUID.optional and string.optional —
      // not nullable). Build the body explicitly, coercing null → undefined so
      // JSON.stringify drops the keys.
      const p = payload as import("./contracts-payloads").SaleCreatePayload;
      const saleBody = {
        items: p.items,
        total: p.total,
        customerId: p.customerId ?? undefined,
        defaultCustomerName: p.defaultCustomerName,
        locale: p.locale ?? undefined,
        paymentMethod: p.paymentMethod ?? undefined,
        skipAutoWhatsapp: p.skipAutoWhatsapp ?? undefined,
      };
      return executeMutationRequest(action, "/api/sales/create", "POST", payload, saleBody);
    }
    case "stock.adjust":
      return executeMutationRequest(action, "/api/products", "PATCH", payload);
    case "stock-load.create":
      return executeMutationRequest(action, "/api/stock-loads", "POST", payload);
    case "cash-movement.create":
      return executeMutationRequest(action, "/api/cash-movements", "POST", payload);
    case "product.create": {
      // Strip businessId: createProductBodySchema uses .strict() and derives
      // businessId server-side from auth context.
      const { businessId: _businessId, ...productBody } = payload as import("./contracts-payloads").ProductCreatePayload;
      return executeMutationRequest(action, "/api/products", "POST", payload, productBody);
    }
    case "product.update":
      return executeMutationRequest(action, "/api/products", "PATCH", payload);
    case "product.delete":
      return executeMutationRequest(action, "/api/products", "DELETE", payload);
    case "product.resolve-or-create":
      return executeMutationRequest(action, "/api/products/resolve-or-create", "POST", payload);
    case "customer.create": {
      // Strip businessId: createCustomerBodySchema uses .strict() and derives
      // businessId server-side from auth context.
      const { businessId: _businessId, ...customerBody } = payload as import("./contracts-payloads").CustomerCreatePayload;
      return executeMutationRequest(action, "/api/customers", "POST", payload, customerBody);
    }
    case "customer.update":
      return executeMutationRequest(action, "/api/customers", "PATCH", payload);
    case "customer.delete":
      return executeMutationRequest(action, "/api/customers", "DELETE", payload);
    case "supplier.create": {
      // Strip businessId: supplierCreateSchema uses .strict() and derives
      // businessId server-side from auth context.
      const { businessId: _businessId, ...supplierBody } = payload as import("./contracts-payloads").SupplierCreatePayload;
      return executeMutationRequest(action, "/api/suppliers", "POST", payload, supplierBody);
    }
    case "supplier.update":
      return executeMutationRequest(action, "/api/suppliers", "PATCH", payload);
    case "supplier.delete":
      return executeMutationRequest(action, "/api/suppliers", "DELETE", payload);
    case "invoice.update-status": {
      const invoiceStatusPayload = payload as ActionPayload<"invoice.update-status">;
      return executeMutationRequest(
        action,
        `/api/invoices/${invoiceStatusPayload.invoiceId}`,
        "PATCH",
        invoiceStatusPayload,
        { status: invoiceStatusPayload.status }
      );
    }
    case "invoice.send-whatsapp": {
      const invoiceWhatsappPayload = payload as ActionPayload<"invoice.send-whatsapp">;
      return executeMutationRequest(
        action,
        `/api/invoices/${invoiceWhatsappPayload.invoiceId}/send-whatsapp`,
        "POST",
        invoiceWhatsappPayload,
        {
          phone: invoiceWhatsappPayload.phone ?? null,
          payload: invoiceWhatsappPayload.payload ?? null,
          invoiceNumber: invoiceWhatsappPayload.invoiceNumber ?? null,
        }
      );
    }
    case "product.bulk-price-update":
      return executeMutationRequest(action, "/api/products/bulk-price-update", "POST", payload);
    case "business.update":
      return executeMutationRequest(action, "/api/business", "PATCH", payload);
    case "undo.execute":
      return executeMutationRequest(action, "/api/undo", "POST", payload);
    case "purchase-request.create":
      return executeMutationRequest(action, "/api/purchase-requests", "POST", payload);
    case "purchase-request.send-whatsapp": {
      const purchaseRequestPayload = payload as ActionPayload<"purchase-request.send-whatsapp">;
      return executeMutationRequest(
        action,
        `/api/purchase-requests/${purchaseRequestPayload.requestId}/send-whatsapp`,
        "POST",
        purchaseRequestPayload,
        null
      );
    }
    case "budget.create":
      return executeMutationRequest(action, "/api/budgets", "POST", payload);
    case "budget.delete":
      return executeMutationRequest(action, "/api/budgets", "DELETE", payload);
    case "budget.send-whatsapp": {
      const budgetWhatsappPayload = payload as ActionPayload<"budget.send-whatsapp">;
      return executeMutationRequest(
        action,
        `/api/budgets/${budgetWhatsappPayload.budgetId}/send-whatsapp`,
        "POST",
        budgetWhatsappPayload,
        { phone: budgetWhatsappPayload.phone }
      );
    }
    case "push-notifications.subscribe":
      return executeMutationRequest(action, "/api/push-notifications/subscribe", "POST", payload);
    case "product.multi-price-update":
      return executeMutationRequest(action, "/api/products/multi-price-update", "POST", payload);
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`ActionKey no soportada: ${String(exhaustiveCheck)}`);
    }
  }
}
