import { chooseLongerText, normalizeActionText, normalizeForMatching } from "../shared";
import type { AssistantTaskModelResponse } from "../types";
import { cleanupSupplierName } from "./supplier-cleanup";
import { findBestSupplierMatch } from "./supplier-matching";

type SupplierEditField = "name" | "phone" | "email" | "contactName" | "taxId";

function normalizeSupplierEditField(value: unknown): SupplierEditField | "" {
  const normalized = normalizeActionText(value).toLowerCase();
  if (!normalized) return "";

  // English field names (from Gemini JSON)
  if (/^name$/i.test(normalized)) return "name";
  if (/^(?:phone|telephone)$/i.test(normalized)) return "phone";
  if (/^(?:email|mail)$/i.test(normalized)) return "email";
  if (/^(?:contactname|contact_name|contact)$/i.test(normalized)) return "contactName";
  if (/^(?:taxid|tax_id)$/i.test(normalized)) return "taxId";

  // Spanish field names (from user text or fallback extraction)
  if (/(?:^|\b)(?:nombre)(?:\b|$)/i.test(normalized)) return "name";
  if (/(?:^|\b)(?:telefono|tel[eé]fono|celular|cel|whatsapp)(?:\b|$)/i.test(normalized)) return "phone";
  if (/(?:^|\b)(?:correo)(?:\b|$)/i.test(normalized)) return "email";
  if (/(?:^|\b)(?:contacto|responsable|encargado)(?:\b|$)/i.test(normalized)) return "contactName";
  if (/(?:^|\b)(?:cuit|cuil|dni)(?:\b|$)/i.test(normalized)) return "taxId";

  return "";
}

function isSupportedSupplierEditField(field: SupplierEditField | ""): field is "name" | "phone" | "email" | "contactName" {
  return field === "name" || field === "phone" || field === "email" || field === "contactName";
}

function supplierEditClarification(
  reason: "missing_supplier" | "ambiguous_supplier" | "missing_field" | "missing_value" | "unsupported_field" | "invalid_email"
) {
  if (reason === "missing_supplier") {
    return {
      answer: "Necesito saber qué proveedor querés editar. Decime el nombre completo.",
      inputHint: "Ej: editar proveedor Aceros del Oeste",
    };
  }

  if (reason === "ambiguous_supplier") {
    return {
      answer: "Encontré varios proveedores parecidos. Decime cuál es.",
      inputHint: "Ej: editar proveedor Aceros del Oeste SRL",
    };
  }

  if (reason === "missing_field") {
    return {
      answer: "Necesito saber qué dato querés cambiar: nombre, teléfono, correo o contacto.",
      inputHint: "Ej: cambiar el teléfono del proveedor",
    };
  }

  if (reason === "unsupported_field") {
    return {
      answer: "Puedo editar nombre, teléfono, correo o contacto del proveedor. CUIT/CUIL todavía no está soportado.",
      inputHint: "Ej: cambiar el contacto de Aceros del Oeste a Pablo",
    };
  }

  if (reason === "invalid_email") {
    return {
      answer: "El correo electrónico no tiene un formato válido. Revisá y volvé a intentar.",
      inputHint: "Ej: ventas@aceros.com",
    };
  }

  return {
    answer: "Necesito el nuevo valor para ese campo.",
    inputHint: "Ej: teléfono a 2615551234",
  };
}

export function extractSupplierEditFromRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const fieldCandidates: Array<{ field: SupplierEditField; terms: string[] }> = [
    { field: "phone", terms: ["telefono", "teléfono", "celular", "cel", "whatsapp"] },
    { field: "email", terms: ["correo"] },
    { field: "contactName", terms: ["contacto", "responsable", "encargado", "persona de contacto"] },
    { field: "name", terms: ["nombre", "se llama"] },
    { field: "taxId", terms: ["cuit", "cuil", "dni"] },
  ];

  const matches = fieldCandidates.filter(({ terms }) => terms.some((term) => normalized.includes(normalizeForMatching(term))));
  if (matches.length === 0) return null;

  const { field, terms } = matches[0];
  const fieldPattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const structuredPatterns =
    field === "name"
      ? [
          new RegExp(`(?:proveedor|fabricante)\\s+(.+?)\\s+(?:ahora\\s+)?se\\s+llama\\s+([^,;\\n]+)`, "i"),
          new RegExp(`(?:cambiar|cambia|actualizar|actualiza|editar|edita|modificar|modifica|renombrar)\\s+(?:el\\s+)?(?:proveedor|fabricante)?\\s*(.+?)\\s+(?:a|por|=|:)\\s*([^,;\\n]+)`, "i"),
        ]
      : [
          new RegExp(`(?:${fieldPattern})\\s+(?:de|del|al)\\s+(?:proveedor|fabricante)?\\s*(.+?)\\s+(?:a|=|:)\\s*([^,;\\n]+)`, "i"),
          new RegExp(`(?:cambiar|cambia|actualizar|actualiza|editar|edita|modificar|modifica|corregir|corregi|ajustar|ajusta|poner|pone)\\s+(?:el\\s+|la\\s+)?(?:${fieldPattern})\\s+(?:de|del|al)\\s+(?:proveedor|fabricante)?\\s*(.+?)\\s+(?:a|=|:)\\s*([^,;\\n]+)`, "i"),
        ];

  for (const pattern of structuredPatterns) {
    const match = text.match(pattern);
    if (match?.[1] && match?.[2]) {
      return {
        supplierName: cleanupSupplierName(normalizeActionText(match[1])),
        field,
        value: normalizeActionText(match[2]),
      };
    }
  }

  const valuePatterns = [
    new RegExp(`(?:${fieldPattern})\\s*(?:a|=|:)\\s*([^,;\\n]+)`, "i"),
    new RegExp(`(?:${fieldPattern})\\s+([^,;\\n]+)`, "i"),
  ];

  let rawValue = "";
  for (const pattern of valuePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      rawValue = normalizeActionText(match[1]);
      break;
    }
  }

  const supplierPatterns = [
    new RegExp(`(?:proveedor|fabricante)\\s+(.+?)\\s+(?:${fieldPattern})\\b`, "i"),
    new RegExp(`^(?:cambiar|actualizar|editar|modificar)(?:\\s+(?:proveedor|fabricante))?\\s+(.+?)\\s+(?:${fieldPattern})\\b`, "i"),
    new RegExp(`(?:${fieldPattern})\\s+(?:de|del|al)\\s+(?:proveedor|fabricante)?\\s*(.+?)(?=\\s+(?:a|=|:)|[.!?]|$)`, "i"),
  ];

  let supplierName = "";
  for (const pattern of supplierPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      supplierName = cleanupSupplierName(normalizeActionText(match[1]));
      break;
    }
  }

  // Strip supplier name from value if it leaked into the capture
  let value = rawValue;
  if (value && supplierName) {
    value = normalizeActionText(value.replace(supplierName, "").replace(/^\s*(?:a|=|:)\s*/i, ""));
  }

  return {
    supplierName,
    field,
    value,
  };
}

export function resolveSupplierEditRequest(
  text: string,
  parsed: AssistantTaskModelResponse,
  suppliers: { id: string; name: string }[]
) {
  const fallbackEdit = extractSupplierEditFromRequest(text);
  const field = normalizeSupplierEditField(parsed.supplierEdit?.field) || fallbackEdit?.field || "";
  const value = normalizeActionText(parsed.supplierEdit?.value) || fallbackEdit?.value || "";
  const parsedSupplierName = chooseLongerText(
    cleanupSupplierName(normalizeActionText(parsed.supplier?.name)),
    fallbackEdit?.supplierName || ""
  );

  // Validate: supplier identity → field → value (same priority order as customer edit)
  if (!parsedSupplierName) {
    return { clarification: supplierEditClarification("missing_supplier") };
  }

  const supplierMatch = findBestSupplierMatch(parsedSupplierName, suppliers);
  if (supplierMatch.ambiguous) {
    return { clarification: supplierEditClarification("ambiguous_supplier") };
  }

  if (!supplierMatch.match) {
    return { clarification: supplierEditClarification("missing_supplier") };
  }

  if (!field) {
    return { clarification: supplierEditClarification("missing_field") };
  }

  if (!isSupportedSupplierEditField(field)) {
    return { clarification: supplierEditClarification("unsupported_field") };
  }

  const isWeakSupplierName = (v: string) => {
    const cleaned = cleanupSupplierName(v);
    return !cleaned || /^(?:proveedor|fabricante|nuevo|nueva|empresa|negocio)$/i.test(cleaned);
  };
  if (!value || (field === "name" && isWeakSupplierName(value))) {
    return { clarification: supplierEditClarification("missing_value") };
  }

  // Field-specific validation
  if (field === "email" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { clarification: supplierEditClarification("invalid_email") };
  }

  return {
    action: {
      type: "edit_supplier" as const,
      supplier: {
        id: supplierMatch.match.id,
        name: supplierMatch.match.name,
      },
      field,
      value,
    },
  };
}
