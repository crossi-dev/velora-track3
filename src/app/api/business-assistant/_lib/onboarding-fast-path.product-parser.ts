// T5 product input parser — "Nombre Precio" free-form entry during onboarding.
// Split from onboarding-fast-path.parsers.ts to keep that file under 300 lines.
//
// Used at turn 5 AFTER detectT5Choice returns null: the owner already chose
// "escribir a mano" / "voz" in a prior T5a reply and is now sending the first
// product (e.g. "Alfajor 800"). No verb required — the dueño is mid-flow.
//
// Guardrails:
//   - Name ≥ 2 alphanum chars.
//   - Price positive, up to 10 digits.
//   - Bare numbers rejected (T4 re-entry or T5b stock).
//   - Mode chip values (foto/voz/escribir) rejected by detectT5Choice upstream.

import { normalizeForMatching } from "@/lib/normalize";

// "Alfajor 800", "Coca Cola 1.5L 600", "Alfajor a 800", "Alfajor $800 pesos"
const T5_PRODUCT_RE = /^(.+?)\s+(?:a\s+|por\s+|precio\s+)?\$?\s*(\d{1,10})\s*(?:pesos?)?\s*\.?\s*$/i;

export interface T5ProductInput {
  name: string;
  price: number;
}

export function parseT5ProductInput(text: string): T5ProductInput | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Bare digits / money-only strings → T4 re-entry or T5b stock, not name+price.
  if (/^\$?\d[\d.,\s]*$/.test(trimmed)) return null;

  const normalized = normalizeForMatching(trimmed);
  const m = normalized.match(T5_PRODUCT_RE);
  if (!m) return null;

  const rawName = m[1].trim().replace(/[,.;:!?]+$/g, "").trim();
  if (!rawName || rawName.length < 2 || !/[a-z0-9]{2,}/i.test(rawName)) return null;

  const price = Number.parseInt(m[2], 10);
  if (!Number.isFinite(price) || price <= 0) return null;

  // Preserve original casing: strip price suffix from the original trimmed text.
  const originalName = trimmed
    .replace(new RegExp(`\\s+\\$?\\s*${m[2]}\\s*(?:pesos?)?\\s*\\.?\\s*$`, "i"), "")
    .trim()
    .replace(/[,.;:!?]+$/g, "")
    .trim();

  return { name: originalName || rawName, price };
}
