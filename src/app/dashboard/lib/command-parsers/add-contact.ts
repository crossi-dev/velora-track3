import { tLang } from "../DashboardLangContext";
import type { AddContactData, ContactKind, VeloraSingleCommand } from "./shared";

export type { AddContactData, ContactKind };

// Anchored entry patterns. The NAME capture is lazy up to the first
// comma or end-of-string so trailing ", tel ..." / ", email ..." parts
// don't get swallowed into the name.
const CUSTOMER_PATTERNS: RegExp[] = [
  /^(?:nuevo\s+|nueva\s+)?cliente\s+(?!como\b)(.+?)(?:,\s*(.+))?\s*$/,
  /^(?:agrega(?:le|me)?|agrega|agregar)\s+(?:a\s+)?(.+?)\s+como\s+cliente(?:,\s*(.+))?\s*$/,
];

const SUPPLIER_PATTERNS: RegExp[] = [
  /^(?:nuevo\s+|nueva\s+)?proveedor\s+(?!como\b)(.+?)(?:,\s*(.+))?\s*$/,
  /^(?:agrega(?:le|me)?|agrega|agregar)\s+(?:al\s+|a\s+)?proveedor\s+(.+?)(?:,\s*(.+))?\s*$/,
  /^(?:agrega(?:le|me)?|agrega|agregar)\s+(?:a\s+)?(.+?)\s+como\s+proveedor(?:,\s*(.+))?\s*$/,
];

// Extract labelled fields from the optional "rest" string after the
// first comma: "tel 11-2345, email x@y.com, contacto pedro, cuit 20-..."
// Each label + value pair separated by comma.
function extractFields(rest: string | undefined): {
  phone: string | null;
  email: string | null;
  taxId: string | null;
  contactName: string | null;
} {
  const out = { phone: null as string | null, email: null as string | null, taxId: null as string | null, contactName: null as string | null };
  if (!rest) return out;
  const parts = rest.split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const phoneMatch = part.match(/^(?:tel|telefono|cel|celular|whatsapp)\s+(.+)$/);
    if (phoneMatch) { out.phone = phoneMatch[1].trim(); continue; }
    const emailMatch = part.match(/^(?:email|correo|mail)\s+(.+)$/) ?? part.match(/^(\S+@\S+\.\S+)$/);
    if (emailMatch) { out.email = emailMatch[1].trim(); continue; }
    const taxMatch = part.match(/^(?:cuit|cuil)\s+(.+)$/);
    if (taxMatch) { out.taxId = taxMatch[1].trim(); continue; }
    const contactMatch = part.match(/^contacto\s+(.+)$/);
    if (contactMatch) { out.contactName = contactMatch[1].trim(); continue; }
  }
  return out;
}

// Confidence check: reject names that are clearly not real names (all
// digits, too short, or purely a stop-word fragment). Falls through to
// AI per the null-resolution rule.
function isPlausibleName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  // Reject if the "name" is just digits / hyphens / spaces — that's a
  // phone number or a parser artifact, not a real name.
  if (/^[\d\s-]+$/.test(trimmed)) return false;
  // Reject if it starts with a known label token (parser glitch)
  if (/^(tel|cel|email|cuit|cuil|contacto)\b/.test(trimmed)) return false;
  return true;
}

function tryPatterns(normalized: string, patterns: RegExp[], kind: ContactKind): VeloraSingleCommand | null {
  for (const pattern of patterns) {
    const m = normalized.match(pattern);
    if (!m) continue;
    const name = m[1].trim();
    const rest = m[2];
    if (!isPlausibleName(name)) return null; // fall through to AI
    const fields = extractFields(rest);
    return {
      matched: true,
      intent: "add_contact",
      data: { kind, name, ...fields },
    };
  }
  return null;
}

export function detectAddContact(normalized: string): VeloraSingleCommand | null {
  return tryPatterns(normalized, SUPPLIER_PATTERNS, "supplier") ?? tryPatterns(normalized, CUSTOMER_PATTERNS, "customer");
}

export function buildAddContactConfirmMessage(data: AddContactData): string {
  const kindLabel = data.kind === "customer" ? tLang("customer", "cliente") : tLang("supplier", "proveedor");
  const parts: string[] = [tLang(`Create ${kindLabel} "${data.name}"`, `¿Crear ${kindLabel} "${data.name}"`)];
  const extras: string[] = [];
  if (data.phone) extras.push(`tel: ${data.phone}`);
  if (data.email) extras.push(`email: ${data.email}`);
  if (data.taxId) extras.push(`CUIT: ${data.taxId}`);
  if (data.contactName) extras.push(`contacto: ${data.contactName}`);
  if (extras.length > 0) parts.push(` (${extras.join(", ")})`);
  parts.push("?");
  return parts.join("");
}
