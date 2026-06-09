import { chooseLongerText, normalizeActionText } from "../shared";
import type { AssistantTaskModelResponse } from "../types";
import { extractCustomerEditFromRequest } from "./customer-extraction";
import { cleanupCustomerName, isWeakCustomerName } from "./customer-intent";
import { findBestCustomerMatch } from "./customer-matching";

type CustomerEditField = "name" | "phone" | "email" | "taxId" | "address" | "notes";

function normalizeCustomerEditField(value: unknown): CustomerEditField | "" {
  const normalized = normalizeActionText(value).toLowerCase();
  if (!normalized) return "";

  // English field names (from Gemini JSON)
  if (/^name$/i.test(normalized)) return "name";
  if (/^(?:phone|telephone)$/i.test(normalized)) return "phone";
  if (/^(?:email|mail)$/i.test(normalized)) return "email";
  if (/^(?:taxid|tax_id)$/i.test(normalized)) return "taxId";
  if (/^address$/i.test(normalized)) return "address";

  // Spanish field names (from user text or fallback extraction)
  if (/(?:^|\b)(?:nombre)(?:\b|$)/i.test(normalized)) return "name";
  if (/(?:^|\b)(?:telefono|tel[eé]fono|celular|cel|whatsapp)(?:\b|$)/i.test(normalized)) return "phone";
  if (/(?:^|\b)(?:correo)(?:\b|$)/i.test(normalized)) return "email";
  if (/(?:^|\b)(?:cuit|cuil|dni)(?:\b|$)/i.test(normalized)) return "taxId";
  if (/(?:^|\b)(?:direccion|dirección|domicilio)(?:\b|$)/i.test(normalized)) return "address";
  if (/(?:^|\b)(?:nota|notas|comentario|comentarios)(?:\b|$)/i.test(normalized)) return "notes";

  return "";
}

function isSupportedCustomerEditField(field: CustomerEditField | ""): field is "name" | "phone" | "email" | "taxId" {
  return field === "name" || field === "phone" || field === "email" || field === "taxId";
}

function customerEditClarification(
  reason: "missing_customer" | "ambiguous_customer" | "missing_field" | "missing_value" | "unsupported_field"
) {
  if (reason === "missing_customer") {
    return {
      answer: "Necesito saber qué cliente querés editar. Decime el nombre completo.",
      inputHint: "Ej: editar Juan Pérez",
    };
  }

  if (reason === "ambiguous_customer") {
    return {
      answer: "Encontré varios clientes parecidos. Decime cuál es.",
      inputHint: "Ej: editar Juan Pérez de Repuestos SRL",
    };
  }

  if (reason === "missing_field") {
    return {
      answer: "Necesito saber qué dato querés cambiar: nombre, teléfono, correo o CUIT/CUIL.",
      inputHint: "Ej: cambiar el teléfono de Juan",
    };
  }

  if (reason === "unsupported_field") {
    return {
      answer: "Puedo editar nombre, teléfono, correo o CUIT/CUIL del cliente. Dirección y notas todavía no están soportadas.",
      inputHint: "Ej: cambio el teléfono de Juan a 2615551234",
    };
  }

  return {
    answer: "Necesito el nuevo valor para ese campo.",
    inputHint: "Ej: teléfono a 2615551234",
  };
}

export function resolveCustomerEditRequest(
  text: string,
  parsed: AssistantTaskModelResponse,
  customers: { id: string; name: string }[]
) {
  const fallbackEdit = extractCustomerEditFromRequest(text);
  const field = normalizeCustomerEditField(parsed.customerEdit?.field) || fallbackEdit?.field || "";
  const value = normalizeActionText(parsed.customerEdit?.value) || fallbackEdit?.value || "";
  const parsedCustomerName = chooseLongerText(
    cleanupCustomerName(normalizeActionText(parsed.customer?.name)),
    fallbackEdit?.customerName || ""
  );

  // Validate in priority order: customer identity → field → value
  if (!parsedCustomerName) {
    return { clarification: customerEditClarification("missing_customer") };
  }

  const customerMatch = findBestCustomerMatch(parsedCustomerName, customers);
  if (customerMatch.ambiguous) {
    return { clarification: customerEditClarification("ambiguous_customer") };
  }

  if (!customerMatch.match) {
    return { clarification: customerEditClarification("missing_customer") };
  }

  if (!field) {
    return { clarification: customerEditClarification("missing_field") };
  }

  if (!isSupportedCustomerEditField(field)) {
    return { clarification: customerEditClarification("unsupported_field") };
  }

  if (!value || (field === "name" && isWeakCustomerName(value))) {
    return { clarification: customerEditClarification("missing_value") };
  }

  return {
    action: {
      type: "edit_customer" as const,
      customer: {
        id: customerMatch.match.id,
        name: customerMatch.match.name,
      },
      field,
      value,
    },
  };
}
