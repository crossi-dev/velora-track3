import { normalizeActionText, normalizeForMatching } from "../shared";
import { cleanupCustomerName } from "./customer-intent";

type CustomerEditField = "name" | "phone" | "email" | "taxId" | "address" | "notes";

type FieldCandidate = { field: CustomerEditField; terms: string[] };

type CustomerEditResult = {
  customerName: string;
  field: CustomerEditField;
  value: string;
};

function cleanupExtractedField(value: string) {
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

function extractLabeledField(text: string, labels: string[], flags = "i") {
  const pattern = new RegExp(`(?:${labels.join("|")})\\s*[:=]?\\s*([^,;\\n]+)`, flags);
  const match = text.match(pattern);
  return cleanupExtractedField(match?.[1] ?? "");
}

const EDIT_FIELD_CANDIDATES: FieldCandidate[] = [
  { field: "phone", terms: ["telefono", "teléfono", "celular", "cel", "whatsapp"] },
  { field: "email", terms: ["correo"] },
  { field: "taxId", terms: ["cuit", "cuil", "dni"] },
  { field: "name", terms: ["nombre", "se llama"] },
  { field: "address", terms: ["direccion", "dirección", "domicilio"] },
  { field: "notes", terms: ["nota", "notas", "comentario", "comentarios"] },
];

function detectEditField(normalized: string): FieldCandidate | null {
  const match = EDIT_FIELD_CANDIDATES.find(({ terms }) =>
    terms.some((term) => normalized.includes(normalizeForMatching(term)))
  );
  return match ?? null;
}

// Hoisted: regex for field === "name" doesn't depend on fieldPattern, so it
// can be compiled once at module load instead of on every call. The other
// patterns are field-dependent (fieldPattern interpolated) and stay inline;
// memoization by fieldPattern would add Map lookup cost without a clear win
// at current hot-path volume.
const NAME_EDIT_PATTERNS: RegExp[] = [
  /(?:cliente)\s+(.+?)\s+(?:ahora\s+)?se\s+llama\s+([^,;\n]+)/i,
  /(?:cambiar|cambia|actualizar|actualiza|editar|edita|modificar|modifica|renombrar)\s+(?:el\s+)?(?:cliente)?\s*(.+?)\s+(?:a|por|=|:)\s*([^,;\n]+)/i,
];

function buildStructuredEditPatterns(field: CustomerEditField, fieldPattern: string): RegExp[] {
  if (field === "name") return NAME_EDIT_PATTERNS;
  return [
    new RegExp(`(?:${fieldPattern})\\s+(?:de|del|al)\\s+(?:cliente)?\\s*(.+?)\\s+(?:a|=|:)\\s*([^,;\\n]+)`, "i"),
    new RegExp(`(?:cambiar|cambia|actualizar|actualiza|editar|edita|modificar|modifica|corregir|corregi|ajustar|ajusta|poner|pone)\\s+(?:el\\s+|la\\s+)?(?:${fieldPattern})\\s+(?:de|del|al)\\s+(?:cliente)?\\s*(.+?)\\s+(?:a|=|:)\\s*([^,;\\n]+)`, "i"),
  ];
}

function matchStructuredEdit(
  text: string,
  patterns: RegExp[],
  field: CustomerEditField
): CustomerEditResult | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && match?.[2]) {
      return {
        customerName: cleanupCustomerName(normalizeActionText(match[1])),
        field,
        value: normalizeActionText(match[2]),
      };
    }
  }
  return null;
}

function extractEditValue(text: string, fieldPattern: string): string {
  const valuePatterns = [
    new RegExp(`(?:${fieldPattern})\\s*(?:a|=|:)\\s*([^,;\\n]+)`, "i"),
    new RegExp(`(?:${fieldPattern})\\s+([^,;\\n]+)`, "i"),
  ];
  for (const pattern of valuePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeActionText(match[1]);
  }
  return "";
}

function extractEditCustomerName(text: string, fieldPattern: string): string {
  const customerPatterns = [
    new RegExp(`(?:cliente)\\s+(.+?)\\s+(?:${fieldPattern})\\b`, "i"),
    new RegExp(`^(?:cambiar|actualizar|editar|modificar)(?:\\s+(?:cliente))?\\s+(.+?)\\s+(?:${fieldPattern})\\b`, "i"),
    new RegExp(`(?:${fieldPattern})\\s+(?:de|del|al)\\s+(?:cliente)?\\s*(.+?)(?=\\s+(?:a|=|:)|[.!?]|$)`, "i"),
  ];
  for (const pattern of customerPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanupCustomerName(normalizeActionText(match[1]));
  }
  return "";
}

export function extractCustomerEditFromRequest(text: string): CustomerEditResult | null {
  const normalized = normalizeForMatching(text);
  const candidate = detectEditField(normalized);
  if (!candidate) return null;

  const { field, terms } = candidate;
  const fieldPattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  const structured = matchStructuredEdit(text, buildStructuredEditPatterns(field, fieldPattern), field);
  if (structured) return structured;

  return {
    customerName: extractEditCustomerName(text, fieldPattern),
    field,
    value: extractEditValue(text, fieldPattern),
  };
}

function extractQuotedName(text: string): string {
  const quotedMatch = text.match(/"([^"\n]+)"|"([^"\n]+)"|'([^'\n]+)'/);
  if (!quotedMatch) return "";
  return normalizeActionText(quotedMatch[1] ?? quotedMatch[2] ?? quotedMatch[3] ?? "");
}

function extractNameFromPatterns(text: string): string {
  const patterns = [
    /\b(?:registr(?:a|ar|ame)|agend(?:a|ar|ame))\s+a\s+([A-Za-záéíóúñüÁÉÍÓÚÑÜ][^,;\n]+?)(?:\s+como\s+(?:clienta?|contacto)\b|[,;]|$)/i,
    /\b(?:agreg(?:a|ar|ame)|guard(?:a|ar|ame)|anot(?:a|ar|ame))\s+(?:a\s+)?(?:mi\s+)?(?:cel(?:ular)?|contacto|agenda|numero)\s+([A-Za-záéíóúñüÁÉÍÓÚÑÜ][^,;\n]+?)(?:\s+(?:pero|y|con|tel|cel|celular|telefono|el\s+telefono)\b|[,;]|$)/i,
    /\b(?:crear|crea|agregar|agrega|registrar|registra|carg(?:a|ar|ame)|sum(?:a|ar|ame)|anot(?:a|ar|ame)|incorpor(?:a|ar|ame)|ingres(?:a|ar|ame))\s+(?:al?\s+)?(?:cliente|contacto)(?:\s+(?:nuevo|nueva))?\s+(?:con\s+nombre\s+)([^,;\n]+)/i,
    /\b(?:crear|crea|agregar|agrega|registrar|registra|carg(?:a|ar|ame)|sum(?:a|ar|ame)|anot(?:a|ar|ame)|incorpor(?:a|ar|ame)|ingres(?:a|ar|ame))\s+(?:al?\s+)?(?:cliente|contacto)(?:\s+(?:nuevo|nueva))?\s*[:=]?\s*([^,;\n]+)/i,
    /\b(?:(?:da|dame)\s+de\s+alta|dar\s+de\s+alta|dar\s+alta)\s+(?:a(?:l)?)?\s*(?:un\s+|una\s+)?(?:cliente|contacto)(?:\s+(?:nuevo|nueva))?\s*[:=]?\s*([^,;\n]+)/i,
    /\b(?:quiero|necesito|necesit(?:aria|aría))\s+(?:un\s+|una\s+)?(?:cliente|contacto)(?:\s+(?:nuevo|nueva))?\s*[:=]?\s*([^,;\n]+)/i,
    /\b(?:cliente|contacto)(?:\s+(?:nuevo|nueva))?\s*[:=]?\s*([^,;\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeActionText(match[1]);
  }
  return "";
}

function stripFieldsFromName(name: string, email: string, phone: string, taxId: string): string {
  let stripped = name;
  if (email) stripped = stripped.replace(email, "");
  if (phone) stripped = stripped.replace(phone, "");
  if (taxId) stripped = stripped.replace(taxId, "");
  return cleanupCustomerName(stripped);
}

// Field boundary: where one labeled field ends and the next begins.
// Used to prevent phone (and other) extractors from consuming the rest of the
// message when multiple fields follow in sequence.
const FIELD_BOUNDARY_RE =
  /\b(?:tel[eé]fono|telefono|celular|cel|whatsapp|correo|email|dni|cuit|cuil|documento|domicilio|direcci[oó]n|direccion|cp|c\.p\.|c[oó]digo\s+postal|codigo\s+postal|ciudad)\b/i;

// Truncate raw field value at the next labeled field boundary so extractors
// don't consume subsequent fields.
function truncateAtNextField(value: string): string {
  const match = FIELD_BOUNDARY_RE.exec(value);
  return match ? value.slice(0, match.index).trim() : value;
}

// DNI argentino: 7-8 digits optionally formatted with dots/spaces (e.g. 32.316.528).
// Captured WITHOUT formatting separators in the output.
// Distinct from CUIT/CUIL (11 digits): this only matches 7-8 digit blocks.
function extractDni(text: string): string {
  const match = text.match(
    /\b(?:dni|documento)[\s:=]*(\d[\d.\s]{5,10}\d)\b/i,
  );
  if (!match?.[1]) return "";
  // Strip formatting (dots, spaces) — API schema expects bare digits.
  return normalizeActionText(match[1].replace(/[.\s]/g, ""));
}

// Address: text after "domicilio" / "dirección" up to the next field label or
// a CP/postal-code pattern. Stops greedily at CP N or "Ciudad" boundary.
function extractAddress(text: string): string {
  const match = text.match(
    /\b(?:domicilio|direcci[oó]n|direccion)\s+([^,;\n]+)/i,
  );
  if (!match?.[1]) return "";
  const raw = truncateAtNextField(match[1]);
  // Also strip trailing postal-code fragment (e.g. "Buenos Aires CP 1043").
  return normalizeActionText(raw.replace(/\b(?:CP|C\.P\.|c[oó]digo\s+postal|codigo\s+postal)\s*\d{4,5}\s*$/i, "").trim());
}

// Postal code: 4-5 digits after CP / "código postal" / "codigo postal".
function extractPostalCode(text: string): string {
  const match = text.match(
    /\b(?:CP|C\.P\.|c[oó]digo\s+postal|codigo\s+postal)\s*[:=]?\s*(\d{4,5})\b/i,
  );
  return normalizeActionText(match?.[1] ?? "");
}

// City: Argentine city names are hard to enumerate. Best-effort: capture the
// word(s) immediately after the address and before CP (e.g. "Corrientes 1234
// Buenos Aires CP 1043" → "Mendoza"). We look for a Title-Case word that follows
// a street number and precedes a CP marker.
// Fallback: explicit "ciudad X" / "localidad X" label.
function extractCity(text: string): string {
  // Labeled form: "ciudad Mendoza" / "localidad Buenos Aires".
  const labeledMatch = text.match(
    /\b(?:ciudad|localidad)\s+([A-Za-záéíóúñüÁÉÍÓÚÑÜ][^,;\n\d]+?)(?:\s+(?:CP|C\.P\.|c[oó]digo|codigo|\d)|[,;]|$)/i,
  );
  if (labeledMatch?.[1]) return normalizeActionText(labeledMatch[1]);

  // Positional: text between street number and CP marker inside an address.
  // Pattern: "[domicilio] [street] [number] [City] CP [code]"
  // Uses a non-greedy capture of everything between the last digit run in the
  // street number and the CP marker, then strips the CP label itself.
  const positionalMatch = text.match(
    /\b(?:domicilio|direcci[oó]n|direccion)\s+[^,;\n]+?\d+\s+(.+?)\s+(?:CP|C\.P\.|c[oó]digo\s+postal|codigo\s+postal)\s*\d{4,5}\b/i,
  );
  if (positionalMatch?.[1]) {
    // Strip any trailing CP/postal fragments that snuck in (e.g. the `i` flag
    // can cause partial overlap on short patterns). Also strip bare digits.
    const candidate = positionalMatch[1]
      .replace(/\s*\b(?:CP|C\.P\.)\s*$/i, "")
      .replace(/\d+$/, "")
      .trim();
    if (candidate) return normalizeActionText(candidate);
  }

  return "";
}

export function extractCustomerFromRequest(text: string) {
  const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const email = normalizeActionText(emailMatch?.[0] ?? "");

  // Phone: labeled field, terminated at next field boundary to prevent
  // capturing address / DNI / CP that follow in the same message.
  const phoneRaw = extractLabeledField(text, ["telefono", "tel[eé]fono", "celular", "cel", "whatsapp"]);
  const phone = truncateAtNextField(phoneRaw);

  // DNI captured via its own dedicated extractor (separate from taxId).
  // taxId keeps CUIT/CUIL only — DNI is stored in its own column.
  const dni = extractDni(text);
  const taxId = extractLabeledField(text, ["cuit", "cuil"]);

  // Address, postal code, and city extracted from the address block.
  const address = extractAddress(text);
  const postalCode = extractPostalCode(text);
  const city = extractCity(text);

  const name = extractQuotedName(text) || extractNameFromPatterns(text);
  const cleanedName = stripFieldsFromName(name, email, phone, taxId);
  if (!cleanedName) return null;

  return { name: cleanedName, phone, email, taxId, dni, address, postalCode, city };
}
