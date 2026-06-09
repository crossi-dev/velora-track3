"use client";

import { tLang } from "./DashboardLangContext";
import { normalizeLookupText } from "../../../lib/shared-utils";
import type {
  PendingSaleFlow,
  PendingSaleMissingField,
  RecoverPendingSaleFlowOptions,
} from "./pendingSaleFlow.types";
import { findBestNamedMatch, looksLikeSaleProductReply } from "./pendingSaleFlow.helpers";

export function buildPendingSaleQuestionContext(flow: PendingSaleFlow) {
  return `sale_missing_${flow.missingField}`;
}

export function defaultPendingSaleInputHint(missingField: PendingSaleMissingField) {
  if (missingField === "quantity") return tLang("E.g.: 2 units", "Ej: 2 unidades");
  if (missingField === "price") return "Ej: 1500";
  return tLang("Customer name", "Nombre del cliente");
}

export function buildPendingSaleReminder(flow: PendingSaleFlow) {
  if (flow.missingField === "quantity") {
    return tLang("Quantity is still missing to complete this sale. Tell me how many units you want to register.", "Todavía falta la cantidad para completar esta venta. Decime cuántas unidades querés registrar.");
  }

  if (flow.missingField === "price") {
    if (flow.priceProductName) {
      return tLang(`Unit price for "${flow.priceProductName}" is still missing. Tell me the price per unit.`, `Todavía falta el precio unitario de "${flow.priceProductName}". Decime el valor por unidad.`);
    }
    return tLang("Unit price is still missing to complete this sale. Tell me the price per unit.", "Todavía falta el precio unitario para completar esta venta. Decime el valor por unidad.");
  }

  return tLang("Customer is still missing to complete this sale. Tell me the full name or choose an existing customer.", "Todavía falta el cliente para completar esta venta. Decime el nombre completo o elegí un cliente existente.");
}

export function recoverPendingSaleFlow(options: RecoverPendingSaleFlowOptions): PendingSaleFlow | null {
  const customerContext = options.customerSelectContext ?? null;
  const saleText = (customerContext?.saleText ?? options.saleText ?? "").trim();
  const answer = options.answer?.trim() || "";
  const questionContext = (options.questionContext ?? "").trim();
  const inputHint = options.inputHint?.trim() || null;

  if (customerContext?.saleText?.trim()) {
    return {
      saleText: customerContext.saleText.trim(),
      missingField: "customer",
      answer: answer || tLang("Customer is still missing to complete this sale. Tell me the full name or choose an existing customer.", "Todavía falta el cliente para completar esta venta. Decime el nombre completo o elegí un cliente existente."),
      inputHint: inputHint || defaultPendingSaleInputHint("customer"),
      customerOptions: customerContext.clients,
    };
  }

  if (!saleText) return null;

  if (
    options.parseMissingField?.productId &&
    options.parseMissingField.productName &&
    questionContext === "sale_missing_price"
  ) {
    return {
      saleText,
      missingField: "price",
      answer: answer || tLang(`Unit price for "${options.parseMissingField.productName}" is still missing. Tell me the price per unit.`, `Todavía falta el precio unitario de "${options.parseMissingField.productName}". Decime el valor por unidad.`),
      inputHint: inputHint || defaultPendingSaleInputHint("price"),
      priceProductId: options.parseMissingField.productId,
      priceProductName: options.parseMissingField.productName,
    };
  }

  if (questionContext === "sale_missing_customer") {
    return {
      saleText,
      missingField: "customer",
      answer: answer || tLang("Customer is still missing to complete this sale. Tell me the full name or choose an existing customer.", "Todavía falta el cliente para completar esta venta. Decime el nombre completo o elegí un cliente existente."),
      inputHint: inputHint || defaultPendingSaleInputHint("customer"),
    };
  }

  if (questionContext === "sale_missing_quantity") {
    return {
      saleText,
      missingField: "quantity",
      answer: answer || tLang("Quantity is still missing to complete this sale. Tell me how many units you want to register.", "Todavía falta la cantidad para completar esta venta. Decime cuántas unidades querés registrar."),
      inputHint: inputHint || defaultPendingSaleInputHint("quantity"),
    };
  }

  return null;
}

export function resolvePendingCustomerReply(
  reply: string,
  saleText: string,
  customers: Array<{ id: string; name: string }>,
  products: Array<{ name: string }>
): {
  kind: "customer";
  customer: { id: string; name: string } | null;
} | {
  kind: "wrong_field" | "free_text_customer";
} {
  const normalized = normalizeLookupText(reply);
  if (!normalized) return { kind: "wrong_field" };

  // Don't reject customer names that happen to contain numbers (e.g., "Juan 1234")
  // Only reject if the reply is PURELY a number with no text
  const trimmed = reply.trim();
  if (/^\d+$/.test(trimmed) || /^\$?\d+([.,]\d+)?$/.test(trimmed)) {
    return { kind: "wrong_field" };
  }

  const customerMatch = findBestNamedMatch(reply, customers);
  const productMatch = findBestNamedMatch(reply, products);

  if (
    productMatch.match && (!customerMatch.match || productMatch.score >= customerMatch.score) ||
    looksLikeSaleProductReply(reply, saleText)
  ) {
    return { kind: "wrong_field" };
  }

  if (customerMatch.match) {
    return { kind: "customer", customer: customerMatch.match };
  }

  // Accept any text as a customer name — single names like "Martínez" or "Juan" are valid
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length >= 1) {
    return { kind: "free_text_customer" };
  }

  return { kind: "wrong_field" };
}
