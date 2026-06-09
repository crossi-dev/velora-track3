// Speech-to-text artifact repair.
//
// The browser SpeechRecognition API occasionally emits a single spoken
// word as two tokens separated by a newline or whitespace when the
// speaker pauses mid-word. Observed in the wild: "stoc\nk" instead of
// "stock", "bana na" instead of "banana", "inven tario" instead of
// "inventario". If these fragments reach the Command Layer's regex
// patterns untouched, the patterns miss and the intent falls through
// to the AI unnecessarily.
//
// Repair strategy: for each adjacent token pair whose concatenation
// appears in a small allowlist of Velora domain keywords, merge them.
// The allowlist is deliberately narrow — we'd rather miss a repair
// than wrongly merge two legitimate words ("mi stock" → "mistock").
// Case-insensitive, accent-insensitive comparison; emits the original
// case-preserved concatenation so downstream normalization still runs.

const SPLIT_KEYWORDS = new Set([
  "stock",
  "inventario",
  "producto",
  "productos",
  "precio",
  "precios",
  "venta",
  "ventas",
  "factura",
  "facturas",
  "cliente",
  "clientes",
  "proveedor",
  "proveedores",
  "catalogo",
]);

function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function collapseSplitKeywords(text: string): string {
  // Collapse any whitespace (including newlines) into single spaces so
  // splitting by /\s+/ yields clean tokens.
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;

  const tokens = cleaned.split(" ");
  if (tokens.length < 2) return cleaned;

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const current = tokens[i];
    const next = tokens[i + 1];
    if (next !== undefined) {
      const merged = normalizeForCompare(current + next);
      if (SPLIT_KEYWORDS.has(merged)) {
        out.push(current + next);
        i += 1;
        continue;
      }
    }
    out.push(current);
  }
  return out.join(" ");
}
