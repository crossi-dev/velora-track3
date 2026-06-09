import { describe, it, expect } from "vitest";
import { buildSaleConfirmationText } from "@/app/api/sales/create/sale-confirmation-text";

const item = (productName: string, quantity: number) => ({
  productName,
  quantity,
  unitPrice: 100,
  subtotal: quantity * 100,
});

describe("buildSaleConfirmationText", () => {
  it("single item qty=1 to named customer includes 1× prefix", () => {
    const text = buildSaleConfirmationText({
      items: [item("destornillador", 1)],
      customerName: "Pepe",
      total: 5500,
      currency: "ARS",
    });
    expect(text).toContain("1× destornillador a Pepe");
    expect(text).toMatch(/^💰 Venta:/);
  });

  it("single item qty>1 to named customer keeps qty prefix", () => {
    const text = buildSaleConfirmationText({
      items: [item("destornillador", 3)],
      customerName: "Pepe",
      total: 16500,
      currency: "ARS",
    });
    expect(text).toContain("3× destornillador a Pepe");
  });

  it("Consumidor Final omits 'a {name}'", () => {
    const text = buildSaleConfirmationText({
      items: [item("destornillador", 1)],
      customerName: "Consumidor Final",
      total: 5500,
      currency: "ARS",
    });
    expect(text).toContain("1× destornillador —");
    expect(text).not.toContain(" a ");
  });

  it("Consumidor Final case-insensitive match", () => {
    const text = buildSaleConfirmationText({
      items: [item("destornillador", 1)],
      customerName: "consumidor final",
      total: 5500,
      currency: "ARS",
    });
    expect(text).not.toContain(" a ");
  });

  it("multi-item shows first + 'y N más'", () => {
    const text = buildSaleConfirmationText({
      items: [item("destornillador", 1), item("martillo", 1), item("clavos", 10)],
      customerName: "Pepe",
      total: 20000,
      currency: "ARS",
    });
    expect(text).toContain("1× destornillador y 2 más a Pepe");
  });

  it("two items shows 'y 1 más'", () => {
    const text = buildSaleConfirmationText({
      items: [item("destornillador", 1), item("martillo", 1)],
      customerName: "Pepe",
      total: 11000,
      currency: "ARS",
    });
    expect(text).toContain("y 1 más");
  });

  it("invalid currency code falls back to peso-style format", () => {
    const text = buildSaleConfirmationText({
      items: [item("destornillador", 1)],
      customerName: "Consumidor Final",
      total: 5500,
      currency: "XYZ_INVALID",
    });
    expect(text).toMatch(/\$/);
  });

  it("formats ARS with locale separators", () => {
    const text = buildSaleConfirmationText({
      items: [item("destornillador", 1)],
      customerName: "Consumidor Final",
      total: 5500,
      currency: "ARS",
    });
    expect(text).toMatch(/5\.500/);
  });
});
