// Distribuidora Mendoza — wholesale.price.quote skill.
//
// Input:  { productName: string; qty: number; deliveryPostalCode?: string }
// Output: { quotes: QuoteOption[] } — always 3 tiered options (A/B/C)
//         OR { error: string } when product not found.
//
// Three tiers per quote:
//   A — Contado inmediato (best price, 100% upfront)
//   B — Financiado 30 días (standard credit)
//   C — Volumen mínimo garantizado (slight premium, fastest delivery)

import { findCatalogItem } from "./catalog";
import { randomUUID } from "crypto";

interface QuoteInput {
  productName?: string;
  qty?: number;
  deliveryPostalCode?: string;
}

export interface QuoteOption {
  quoteId: string;
  optionLabel: "A" | "B" | "C";
  title: string;
  condition: string;
  productName: string;
  unit: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  deliveryDays: number;
  validUntil: string; // ISO 8601 datetime
  currency: string;
}

export interface QuoteSuccessResult {
  quotes: QuoteOption[];
}

interface QuoteError {
  error: string;
}

export type QuoteResult = QuoteSuccessResult | QuoteError;

export function handleQuote(params: QuoteInput): QuoteResult {
  const productName = params.productName ?? "";
  const qty = typeof params.qty === "number" && params.qty > 0 ? params.qty : 1;

  const item = findCatalogItem(productName);
  if (!item) {
    return {
      error: `Producto "${productName}" no encontrado en el catálogo. Productos disponibles: Quilmes, Fernet Branca, Coca-Cola, Sprite, agua, alfajores, harina, aceite, yerba, arroz, fideos, azúcar, sal.`,
    };
  }

  const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const extraDays = params.deliveryPostalCode?.startsWith("54") ? 1 : 0;
  const baseDelivery = item.deliveryDays + extraDays;

  // Option A — Contado inmediato (best price, -5%)
  const priceA = Math.round(item.unitPrice * 0.95);
  // Option B — Financiado 30 días (standard price)
  const priceB = item.unitPrice;
  // Option C — Volumen garantizado (+3% pero entrega más rápida)
  const priceC = Math.round(item.unitPrice * 1.03);

  const quotes: QuoteOption[] = [
    {
      quoteId: randomUUID(),
      optionLabel: "A",
      title: "Contado inmediato",
      condition: "Pago al recibir. 5% de descuento por pago contado.",
      productName: item.name,
      unit: item.unit,
      qty,
      unitPrice: priceA,
      totalPrice: priceA * qty,
      deliveryDays: baseDelivery,
      validUntil,
      currency: "ARS",
    },
    {
      quoteId: randomUUID(),
      optionLabel: "B",
      title: "Financiado 30 días",
      condition: "Pago a 30 días. Precio estándar sin recargo.",
      productName: item.name,
      unit: item.unit,
      qty,
      unitPrice: priceB,
      totalPrice: priceB * qty,
      deliveryDays: baseDelivery + 1,
      validUntil,
      currency: "ARS",
    },
    {
      quoteId: randomUUID(),
      optionLabel: "C",
      title: "Volumen garantizado",
      condition: "Entrega prioritaria. +3% por servicio express.",
      productName: item.name,
      unit: item.unit,
      qty,
      unitPrice: priceC,
      totalPrice: priceC * qty,
      deliveryDays: Math.max(1, baseDelivery - 1),
      validUntil,
      currency: "ARS",
    },
  ];

  return { quotes };
}
