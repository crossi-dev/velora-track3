// Gemini may return unitPrice as "$50", "50 pesos", "$1.500", "1.500,50", etc.
// Must handle both AR format (1.500,50) and US format ($1,500.00)
export function parseUnitPriceString(raw: number | string | undefined): number {
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^0-9.,]/g, "");
    const hasDotThousands = /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(cleaned);
    const hasCommaThousands = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(cleaned);
    let normalized = cleaned;
    if (hasDotThousands) {
      // AR format: 1.500,50 → 1500.50
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else if (hasCommaThousands) {
      // US format: 1,500.00 → 1500.00
      normalized = cleaned.replace(/,/g, "");
    } else if (cleaned.includes(",") && !cleaned.includes(".")) {
      // Simple comma decimal: 50,5 → 50.5
      normalized = cleaned.replace(",", ".");
    }
    return Number(normalized);
  }
  return Number(raw);
}

export function pickUnitPrice(params: {
  parsedUnitPrice: number;
  productPrice: number;
  override: number;
}): number {
  const { parsedUnitPrice, productPrice, override } = params;
  if (Number.isFinite(override) && override > 0) return override;
  if (Number.isFinite(parsedUnitPrice) && parsedUnitPrice > 0) return parsedUnitPrice;
  return productPrice;
}
