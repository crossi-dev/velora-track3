"use client";

import { tLang } from "../DashboardLangContext";
import type { ContactRow, ParsedSale, Product } from "../types";

const MAX_SALE_QUANTITY = 100000;

function toSafeInteger(value: string | number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

function toSafeMoney(value: string | number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Number(parsed.toFixed(2));
}

function resolveCustomerForDraft(customerId: string, clients: ContactRow[]) {
  const matched = clients.find((client) => client.id === customerId);
  if (!matched) {
    return { id: "", name: "Consumidor Final" };
  }
  return { id: matched.id, name: matched.name };
}

export function buildManualSaleDraftFromIntake(input: {
  productId: string;
  quantity: string;
  customerId: string;
  unitPrice: string;
  allowNegativeStock?: boolean;
  products: Product[];
  clients: ContactRow[];
}) {
  const { productId, quantity, customerId, unitPrice, allowNegativeStock = false, products, clients } = input;
  const product = products.find((entry) => entry.id === productId);
  if (!product) {
    return { error: tLang("Could not find the selected product.", "No encontré el producto seleccionado.") };
  }

  const qty = toSafeInteger(quantity);
  if (qty === null || qty <= 0) {
    return { error: tLang("Quantity must be a positive integer.", "La cantidad debe ser un número entero mayor a cero.") };
  }

  if (qty > MAX_SALE_QUANTITY) {
    return { error: tLang(`Quantity exceeds the maximum allowed (${MAX_SALE_QUANTITY}).`, `La cantidad supera el máximo permitido (${MAX_SALE_QUANTITY}).`) };
  }

  if (!allowNegativeStock && qty > product.stock) {
    return {
      error: tLang(`Insufficient stock for ${product.name}. Available: ${product.stock}.`, `No hay stock suficiente para ${product.name}. Disponible: ${product.stock}.`),
    };
  }

  const storedPrice = toSafeMoney(product.price);
  const enteredPrice = toSafeMoney(unitPrice);
  // User-entered price takes priority (discounts, negotiations, special pricing)
  const effectiveUnitPrice =
    enteredPrice !== null && enteredPrice > 0
      ? enteredPrice
      : storedPrice !== null && storedPrice > 0
        ? storedPrice
        : null;

  if (effectiveUnitPrice === null) {
    return { error: tLang(`Missing a valid sale price for ${product.name}.`, `Falta un precio de venta válido para ${product.name}.`) };
  }

  const subtotal = Number((qty * effectiveUnitPrice).toFixed(2));
  const draft: ParsedSale = {
    customer: resolveCustomerForDraft(customerId, clients),
    items: [
      {
        productId: product.id,
        productName: product.name,
        quantity: qty,
        unitPrice: effectiveUnitPrice,
        subtotal,
      },
    ],
    total: subtotal,
  };

  return { draft };
}

export function validateAndNormalizeSaleDraftForCommit(
  draft: ParsedSale,
  products: Product[],
  options?: { allowNegativeStock?: boolean }
): { ok: true; value: ParsedSale } | { ok: false; error: string } {
  if (!draft || !Array.isArray(draft.items) || draft.items.length === 0) {
    return { ok: false, error: tLang("The sale has no items to confirm.", "La venta no tiene ítems para confirmar.") };
  }

  const productById = new Map(products.map((product) => [product.id, product]));
  const normalizedItems: ParsedSale["items"] = [];

  const allowNegativeStock = options?.allowNegativeStock ?? false;

  for (const item of draft.items) {
    const product = productById.get(item.productId);
    if (!product) {
      return { ok: false, error: tLang(`Could not find product "${item.productName}" in the catalog.`, `No encontré el producto "${item.productName}" en el catálogo.`) };
    }

    const quantity = toSafeInteger(item.quantity);
    if (quantity === null || quantity <= 0) {
      return { ok: false, error: tLang(`Quantity for "${item.productName}" must be a positive integer.`, `La cantidad para "${item.productName}" debe ser entera y mayor a cero.`) };
    }

    if (quantity > MAX_SALE_QUANTITY) {
      return { ok: false, error: tLang(`Quantity for "${item.productName}" exceeds the maximum allowed.`, `La cantidad para "${item.productName}" supera el máximo permitido.`) };
    }

    if (!allowNegativeStock && quantity > product.stock) {
      return {
        ok: false,
        error: tLang(`Insufficient stock for ${product.name}. Available: ${product.stock}.`, `No hay stock suficiente para ${product.name}. Disponible: ${product.stock}.`),
      };
    }

    const unitPrice = toSafeMoney(item.unitPrice);
    if (unitPrice === null || unitPrice <= 0) {
      return { ok: false, error: tLang(`Price for "${item.productName}" must be greater than zero.`, `El precio para "${item.productName}" debe ser mayor a cero.`) };
    }

    const subtotal = Number((quantity * unitPrice).toFixed(2));
    normalizedItems.push({
      productId: product.id,
      productName: product.name,
      quantity,
      unitPrice,
      subtotal,
    });
  }

  const total = Number(
    normalizedItems.reduce((acc, item) => acc + item.subtotal, 0).toFixed(2)
  );

  return {
    ok: true,
    value: {
      customer: draft.customer ?? { id: "", name: "Consumidor Final" },
      items: normalizedItems,
      total,
    },
  };
}
