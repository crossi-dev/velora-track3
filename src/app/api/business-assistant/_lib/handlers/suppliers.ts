import {
  normalizeActionText,
  normalizeForMatching,
  termsAreProximate,
} from "../shared";
import type { AssistantTaskModelResponse } from "../types";
import { cleanupSupplierName, extractLabeledField } from "./supplier-cleanup";

export { extractSupplierEditFromRequest, resolveSupplierEditRequest } from "./supplier-edit";

export function looksLikeCreateSupplierRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const supplierTerms = ["proveedor", "fabricante"];
  const createTerms = [
    "crear",
    "crea",
    "agregar",
    "agrega",
    "registrar",
    "registra",
    "nuevo",
    "nueva",
    "cargar",
    "carga",
    "cargame",
    "sumar",
    "suma",
    "sumame",
    "anotar",
    "anota",
    "anotame",
    "incorporar",
    "incorpora",
    "incorporame",
    "ingresar",
    "ingresa",
    "ingresame",
    "alta",
  ];
  return (
    termsAreProximate(normalized, supplierTerms, createTerms) ||
    /\b(?:(?:da|dame)\s+de\s+alta|dar\s+de\s+alta|dar\s+alta|carg(?:a|ar|ame)|sum(?:a|ar|ame)|anot(?:a|ar|ame)|incorpor(?:a|ar|ame)|ingres(?:a|ar|ame))\b.*\b(?:proveedor|fabricante)\b/i.test(
      normalized
    ) ||
    /\b(?:proveedor|fabricante)\b.*\b(?:nuevo|nueva)\b/i.test(normalized)
  );
}

export function looksLikeEditSupplierRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const supplierTerms = ["proveedor", "fabricante"];
  const editTerms = [
    "editar",
    "edita",
    "actualizar",
    "actualiza",
    "cambiar",
    "cambia",
    "modificar",
    "modifica",
    "corregir",
    "corregi",
    "ajustar",
    "ajusta",
    "poner",
    "pone",
  ];
  return (
    termsAreProximate(normalized, supplierTerms, editTerms) ||
    /\b(?:proveedor|fabricante)\b.*\b(?:ahora\s+se\s+llama|se\s+llama)\b/i.test(normalized) ||
    /\b(?:telefono|tel[eé]fono|celular|cel|whatsapp|correo|contacto|responsable|encargado|nombre|cuit|cuil|dni)\b.*\b(?:de|del|al)\b.*\b(?:proveedor|fabricante)\b/i.test(
      normalized
    )
  );
}

export function extractSupplierFromRequest(text: string) {
  const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const email = normalizeActionText(emailMatch?.[0] ?? "");
  const phone = extractLabeledField(text, ["telefono", "tel[eé]fono", "celular", "cel", "whatsapp"]);
  const contactName = extractLabeledField(text, ["contacto", "responsable", "encargado"]);

  let name = "";
  const quotedMatch = text.match(/"([^"\n]+)"|"([^"\n]+)"|'([^'\n]+)'/);
  if (quotedMatch) {
    name = normalizeActionText(quotedMatch[1] ?? quotedMatch[2] ?? quotedMatch[3] ?? "");
  }

  if (!name) {
    const patterns = [
      /\b(?:crear|crea|agregar|agrega|registrar|registra|carg(?:a|ar|ame)|sum(?:a|ar|ame)|anot(?:a|ar|ame)|incorpor(?:a|ar|ame)|ingres(?:a|ar|ame))\s+(?:al?\s+)?(?:proveedor|fabricante)(?:\s+(?:nuevo|nueva))?\s*[:=]?\s*([^,;\n]+)/i,
      /\b(?:(?:da|dame)\s+de\s+alta|dar\s+de\s+alta|dar\s+alta)\s+(?:a(?:l)?)?\s*(?:un\s+|una\s+)?(?:proveedor|fabricante)(?:\s+(?:nuevo|nueva))?\s*[:=]?\s*([^,;\n]+)/i,
      /\b(?:quiero|necesito|necesit(?:aria|aría))\s+(?:un\s+|una\s+)?(?:proveedor|fabricante)(?:\s+(?:nuevo|nueva))?\s*[:=]?\s*([^,;\n]+)/i,
      /\b(?:proveedor|fabricante)(?:\s+(?:nuevo|nueva))?\s*[:=]?\s*([^,;\n]+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        name = normalizeActionText(match[1]);
        break;
      }
    }
  }

  // Strip extracted fields from name — only replace non-empty strings to avoid corruption
  let strippedName = name;
  if (email) strippedName = strippedName.replace(email, "");
  if (phone) strippedName = strippedName.replace(phone, "");
  // Don't strip contactName — it can be a substring of the company name (e.g. "Distribuidora Pablo SRL" + contacto "Pablo")
  const cleanedName = cleanupSupplierName(strippedName);

  if (!cleanedName) return null;

  return {
    name: cleanedName,
    phone,
    email,
    contactName,
  };
}

export function resolveSupplierCreateRequest(
  text: string,
  parsed: AssistantTaskModelResponse
) {
  const createRequested = looksLikeCreateSupplierRequest(text);
  const fallbackSupplier = createRequested ? extractSupplierFromRequest(text) : null;
  const supplier = {
    name: normalizeActionText(parsed.supplier?.name) || fallbackSupplier?.name || "",
    phone: normalizeActionText(parsed.supplier?.phone) || fallbackSupplier?.phone || "",
    email:
      normalizeActionText(parsed.supplier?.email) ||
      fallbackSupplier?.email ||
      "",
    contactName: normalizeActionText(parsed.supplier?.contactName) || fallbackSupplier?.contactName || "",
  };

  if (!supplier.name) {
    return null;
  }

  return {
    action: {
      type: "create_supplier" as const,
      supplier,
    },
  };
}

