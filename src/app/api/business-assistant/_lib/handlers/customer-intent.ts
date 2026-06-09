import { normalizeForMatching, termsAreProximate } from "../shared";

export function looksLikeCreateCustomerRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const customerTerms = ["cliente", "clienta", "contacto"];
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
    termsAreProximate(normalized, customerTerms, createTerms) ||
    /\b(?:(?:da|dame)\s+de\s+alta|dar\s+de\s+alta|dar\s+alta|carg(?:a|ar|ame)|sum(?:a|ar|ame)|anot(?:a|ar|ame)|incorpor(?:a|ar|ame)|ingres(?:a|ar|ame))\b.*\b(?:cliente|contacto)\b/i.test(
      normalized
    ) ||
    /\b(?:cliente|contacto)\b.*\b(?:nuevo|nueva)\b/i.test(normalized) ||
    /\b(?:cre(?:a|ar)|agreg(?:a|ar|ame)|guard(?:a|ar|ame)|anot(?:a|ar|ame)|met(?:e|er|ele))\b.{0,30}\b(?:cel(?:ular)?|numero|telefono|contacto|agenda)\b/i.test(normalized) ||
    /\b(?:agreg(?:a|ar|ame)|guard(?:a|ar|ame))\s+(?:a\s+)?(?:mi\s+)?(?:cel(?:ular)?|contacto|agenda|numero)\b/i.test(normalized) ||
    /\b(?:cre(?:a|ar)|agreg(?:a|ar|ame)|registr(?:a|ar))\b.{0,10}\b(?:cliente|clienta|contacto)\b.{0,10}\b(?:con\s+nombre|nombre)\b/i.test(normalized) ||
    /\b(?:registr(?:a|ar|ame)|agend(?:a|ar|ame))\s+a\s+[A-Za-záéíóúñüÁÉÍÓÚÑÜ]/i.test(text)
  );
}

export function looksLikeEditCustomerRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const customerTerms = ["cliente"];
  const editTerms = [
    "editar",
    "edita",
    "actualizar",
    "actualiza",
    "cambiar",
    "cambia",
    "modificar",
    "modifica",
    "renombrar",
    "corregir",
    "corregi",
    "ajustar",
    "ajusta",
    "poner",
    "pone",
  ];
  return (
    termsAreProximate(normalized, customerTerms, editTerms) ||
    /\b(?:cliente)\b.*\b(?:ahora\s+se\s+llama|se\s+llama)\b/i.test(normalized) ||
    /\b(?:telefono|tel[eé]fono|celular|cel|whatsapp|correo|nombre|cuit|cuil|dni)\b.*\b(?:de|del|al)\b.*\b(?:cliente)\b/i.test(
      normalized
    )
  );
}

export function isWeakCustomerName(value: string) {
  const cleaned = cleanupCustomerName(value);
  if (!cleaned) return true;

  const normalized = normalizeForMatching(cleaned);
  const tokens = normalized.match(/[a-z0-9]+/g) ?? [];
  if (!tokens.length) return true;

  const compact = tokens.join("");
  if (compact.length < 2) return true;

  return /^(?:cliente|nuevo|nueva|a|e|y|de|del|la|el|alguien|persona|empresa|negocio|uno|una)$/i.test(normalizeForMatching(cleaned));
}

export function cleanupCustomerName(value: string) {
  return value
    .replace(
      /\b(?:telefono|tel[eé]fono|celular|cel|whatsapp|correo|dni|cuit|cuil|documento|doc)\b[\s:=].*$/i,
      ""
    )
    .replace(/^(?:nuevo|nueva)\s+/i, "")
    .replace(/^(?:cliente|contacto)\s+/i, "")
    .replace(/^(?:que\s+)?se\s+llam[ae](?:n)?\s+/i, "")
    .replace(/^(?:llamado|llamada)\s+/i, "")
    .replace(/^(?:con\s+nombre\s+)/i, "")
    .replace(/^(?:a\s+(?:quien|quien)\s+llam(?:o|amos|an)\s+)/i, "")
    .replace(/\b(?:con|y)\s*$/i, "")
    .replace(/^[\s"'`""]+|[\s"'`"".,;:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
