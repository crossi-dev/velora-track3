import { normalizeActionText } from "../shared";

export function cleanupExtractedField(value: string) {
  return normalizeActionText(value)
    .replace(
      /\b(?:y|con)\b\s+(?:telefono|tel[eé]fono|celular|cel|whatsapp|correo|dni|cuit|cuil|documento|doc)\b.*$/i,
      ""
    )
    .replace(
      /\b(?:telefono|tel[eé]fono|celular|cel|whatsapp|correo|dni|cuit|cuil|documento|doc)\b.*$/i,
      ""
    )
    .replace(/[.,;:]+$/g, "")
    .trim();
}

export function extractLabeledField(text: string, labels: string[], flags = "i") {
  const pattern = new RegExp(`(?:${labels.join("|")})\\s*[:=]?\\s*([^,;\\n]+)`, flags);
  const match = text.match(pattern);
  return cleanupExtractedField(match?.[1] ?? "");
}

export function cleanupSupplierName(value: string) {
  return value
    .replace(
      /\b(?:telefono|tel[eé]fono|celular|cel|whatsapp|correo|contacto|responsable|encargado|dni|cuit|cuil|documento|doc)\b[\s:=].*$/i,
      ""
    )
    .replace(/^(?:nuevo|nueva)\s+/i, "")
    .replace(/^(?:proveedor|fabricante)\s+/i, "")
    .replace(/^(?:llamado|llamada)\s+/i, "")
    .replace(/\b(?:con)\s*$/i, "")
    .replace(/^[\s"'`\u201C\u201D]+|[\s"'`\u201C\u201D.,;:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function cleanupSupplierRequestItemBase(value: string) {
  return normalizeActionText(value)
    .replace(
      /\b(?:a|al|de|del|para|por|con)\s+(?:un\s+)?(?:proveedor|fabricante)\b.*$/i,
      ""
    )
    .replace(/\b(?:proveedor|fabricante)\b.*$/i, "")
    .replace(/\b(?:producto|productos|ítem|ítems|articulo|articulos|artículo|artículos)\b$/i, "")
    .replace(/^[\s"'`\u201C\u201D]+|[\s"'`\u201C\u201D.,;:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
