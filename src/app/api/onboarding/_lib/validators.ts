export interface ProductInput {
  name: string;
  price?: string | number;
  stock: string | number;
}

export interface CustomerInput {
  name: string;
  phone?: string;
  email?: string;
  taxId?: string;
  customerType?: "finalConsumer" | "business" | string;
}

export interface SupplierInput {
  name: string;
  phone?: string;
  taxId?: string;
  contactName?: string;
  email?: string;
}

export interface OnboardingBody {
  business: {
    name: string;
    type: string;
    cuit?: string;
    address?: string;
    phone?: string;
    workerCount?: number;
    openingCash?: number;
    currency: string;
    openingTime?: string;
    closingTime?: string;
  };
  products: ProductInput[];
  customers: CustomerInput[];
  suppliers: SupplierInput[];
}

export const MAX_FIELD_LENGTH = 500;

export function parseStrictNonNegativeNumber(value: string | number | undefined) {
  if (value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;

  if (!value.trim()) return 0;
  let normalized = value.trim().replace(/\s+/g, "").replace(/[$€£¥]/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export function parseStrictNonNegativeInteger(value: string | number | undefined) {
  const parsed = parseStrictNonNegativeNumber(value);
  return parsed === null ? null : Math.floor(parsed);
}
