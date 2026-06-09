// Business rules for products — pure functions, no UI, no framework dependencies

// Hard block — product must have a name
export function validateProductName(name: string): string | null {
  if (!name || name.trim().length === 0) return "Product name is required.";
  return null;
}

// Hard block — product must have a price > 0
export function validateProductPrice(price: number): string | null {
  if (!Number.isFinite(price) || price <= 0) return "Product price must be greater than zero.";
  return null;
}
