// Typed domain errors — thrown by services, caught by route handlers.
// Using classes instead of string codes gives instanceof checks, typed fields,
// and no fragile string-splitting at the catch site.

export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

export class InsufficientStockError extends DomainError {
  constructor(public readonly productName: string, public readonly available: number) {
    super("INSUFFICIENT_STOCK", `Insufficient stock for "${productName}". Available: ${available}.`);
  }
}

export class PriceOutlierError extends DomainError {
  constructor(
    public readonly productId: string,
    public readonly direction: "above" | "below",
    public readonly expected: number,
  ) {
    super("PRICE_OUTLIER", `Price ${direction} catalog price (expected: ${expected})`);
  }
}

export class ProductNotOwnedError extends DomainError {
  constructor() { super("PRODUCT_NOT_OWNED", "Product does not belong to this business."); }
}

export class BusinessNotFoundError extends DomainError {
  constructor() { super("BUSINESS_NOT_FOUND", "Business not found."); }
}

export class CustomerNotFoundError extends DomainError {
  constructor() { super("CUSTOMER_NOT_FOUND", "Customer not found."); }
}

// message is set to the code string so catch sites that compare
// error.message === "PRODUCT_NAME_REQUIRED" / "PRODUCT_NOT_FOUND" continue to work.
export class ProductNameRequiredError extends DomainError {
  constructor() { super("PRODUCT_NAME_REQUIRED", "PRODUCT_NAME_REQUIRED"); }
}

export class ProductNotFoundError extends DomainError {
  constructor() { super("PRODUCT_NOT_FOUND", "PRODUCT_NOT_FOUND"); }
}

export class InvoiceNotFoundError extends DomainError {
  constructor() { super("INVOICE_NOT_FOUND", "INVOICE_NOT_FOUND"); }
}

export class InvalidItemQuantityError extends DomainError {
  constructor() { super("INVALID_ITEM_QUANTITY", "Each item quantity must be greater than zero."); }
}

export class SaleDateFutureError extends DomainError {
  constructor() { super("SALE_DATE_FUTURE", "Sale date cannot be more than 1 minute in the future."); }
}
