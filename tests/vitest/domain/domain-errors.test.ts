import { describe, it, expect } from "vitest";
import {
  DomainError,
  InsufficientStockError,
  PriceOutlierError,
  ProductNotOwnedError,
  BusinessNotFoundError,
  CustomerNotFoundError,
  InvalidItemQuantityError,
} from "@/domain/errors";

describe("DomainError (base)", () => {
  it("es instanceof Error", () => expect(new DomainError("CODE", "msg")).toBeInstanceOf(Error));
  it("expone .code", () => expect(new DomainError("MY_CODE", "msg").code).toBe("MY_CODE"));
  it("expone .message", () => expect(new DomainError("C", "mi mensaje").message).toBe("mi mensaje"));
  it(".name === code", () => expect(new DomainError("TEST_CODE", "x").name).toBe("TEST_CODE"));
});

describe("InsufficientStockError", () => {
  const err = new InsufficientStockError("Yerba Mate", 3);
  it("instanceof DomainError + Error", () => {
    expect(err).toBeInstanceOf(InsufficientStockError);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(Error);
  });
  it("código correcto", () => expect(err.code).toBe("INSUFFICIENT_STOCK"));
  it("productName preservado", () => expect(err.productName).toBe("Yerba Mate"));
  it("available preservado", () => expect(err.available).toBe(3));
  it("message menciona el producto", () => expect(err.message).toContain("Yerba Mate"));
  it("message menciona el stock disponible", () => expect(err.message).toContain("3"));
});

describe("PriceOutlierError", () => {
  it("dirección 'above' → code + campos", () => {
    const err = new PriceOutlierError("prod-1", "above", 1000);
    expect(err.code).toBe("PRICE_OUTLIER");
    expect(err.productId).toBe("prod-1");
    expect(err.direction).toBe("above");
    expect(err.expected).toBe(1000);
  });
  it("dirección 'below'", () => {
    const err = new PriceOutlierError("prod-2", "below", 500);
    expect(err.direction).toBe("below");
    expect(err.expected).toBe(500);
  });
  it("instanceof chain completo", () => {
    expect(new PriceOutlierError("x", "above", 0)).toBeInstanceOf(DomainError);
  });
});

describe("ProductNotOwnedError", () => {
  const err = new ProductNotOwnedError();
  it("código correcto", () => expect(err.code).toBe("PRODUCT_NOT_OWNED"));
  it("mensaje exacto", () => expect(err.message).toBe("Product does not belong to this business."));
  it("instanceof DomainError", () => expect(err).toBeInstanceOf(DomainError));
});

describe("BusinessNotFoundError", () => {
  const err = new BusinessNotFoundError();
  it("código correcto", () => expect(err.code).toBe("BUSINESS_NOT_FOUND"));
  it("mensaje exacto", () => expect(err.message).toBe("Business not found."));
  it("instanceof DomainError", () => expect(err).toBeInstanceOf(DomainError));
});

describe("CustomerNotFoundError", () => {
  const err = new CustomerNotFoundError();
  it("código correcto", () => expect(err.code).toBe("CUSTOMER_NOT_FOUND"));
  it("mensaje exacto", () => expect(err.message).toBe("Customer not found."));
  it("instanceof DomainError", () => expect(err).toBeInstanceOf(DomainError));
});

describe("InvalidItemQuantityError", () => {
  const err = new InvalidItemQuantityError();
  it("código correcto", () => expect(err.code).toBe("INVALID_ITEM_QUANTITY"));
  it("mensaje exacto", () => expect(err.message).toBe("Each item quantity must be greater than zero."));
  it("instanceof DomainError", () => expect(err).toBeInstanceOf(DomainError));
});

