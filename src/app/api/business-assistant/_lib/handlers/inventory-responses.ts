import { formatMoney, formatNumber } from "../shared";
import type { ProductInfoEntry } from "../types";

export function productEditClarification(
  reason: "missing_product" | "ambiguous_product" | "missing_field" | "missing_value" | "unsupported_field"
) {
  if (reason === "missing_product") {
    return {
      answer: "Necesito saber qué producto querés editar. Decime el nombre.",
      inputHint: "Ej: cambiar el precio de Filtro de aire",
    };
  }

  if (reason === "ambiguous_product") {
    return {
      answer: "Encontré varios productos parecidos. Decime cuál es.",
      inputHint: "Ej: cambiar el precio de Filtro de aire Bosch",
    };
  }

  if (reason === "missing_field") {
    return {
      answer: "Necesito saber qué dato querés cambiar: nombre, precio, costo o SKU.",
      inputHint: "Ej: cambiar el precio de Filtro de aire",
    };
  }

  if (reason === "unsupported_field") {
    return {
      answer: "Puedo editar nombre, precio, costo o SKU del producto. El stock se maneja por la carga de stock.",
      inputHint: "Ej: cambiar el precio de Filtro de aire a 12000",
    };
  }

  return {
    answer: "Necesito el nuevo valor para ese dato.",
    inputHint: "Ej: precio a 12000",
  };
}

export function stockAdjustmentClarification(
  reason: "missing_product" | "ambiguous_product" | "missing_quantity" | "missing_mode"
) {
  if (reason === "missing_product") {
    return {
      answer: "Necesito saber qué producto querés ajustar en stock.",
      inputHint: "Ej: cambiar el stock de Filtro de aire a 10",
    };
  }

  if (reason === "ambiguous_product") {
    return {
      answer: "Encontré varios productos parecidos. Decime cuál es.",
      inputHint: "Ej: cambiar el stock de Filtro Bosch a 10",
    };
  }

  if (reason === "missing_mode") {
    return {
      answer: "¿Querés establecer, sumar o restar stock?",
      inputHint: "Ej: dejar stock en 10 / sumar 5 / restar 3",
    };
  }

  return {
    answer: "Necesito la cantidad exacta para ajustar el stock.",
    inputHint: "Ej: cambiar el stock a 10 o sumar 5 unidades",
  };
}

export function stockLoadClarification(
  reason: "missing_item" | "missing_quantity" | "missing_item_and_quantity"
) {
  if (reason === "missing_item_and_quantity") {
    return {
      answer: "Decime el nombre del ítem y la cantidad para cargar stock.",
      inputHint: "Ej: cargar 10 Filtro Bosch a 1200",
    };
  }

  if (reason === "missing_item") {
    return {
      answer: "Necesito el nombre del ítem para cargar stock.",
      inputHint: "Ej: cargar 10 Filtro Bosch",
    };
  }

  return {
    answer: "Necesito la cantidad para cargar stock.",
    inputHint: "Ej: cargar 10 Filtro Bosch",
  };
}

export function buildProductStockAnswer(product: ProductInfoEntry, locale: string) {
  const stockLabel = formatNumber(product.stock, locale);
  return `${product.name} tiene ${stockLabel} unidades en stock.`;
}

export function buildInventorySummaryAnswer(
  context: {
    business: { name: string; currency: string };
    inventorySummary: { productLines: number; totalUnits: number; totalValue: number };
    products: Array<{ name: string; price: number; stock: number }>;
  },
  locale: string
) {
  if (context.products.length === 0) {
    return "Todavía no hay productos cargados en el inventario.";
  }

  const sorted = [...context.products].sort((a, b) => b.stock - a.stock);
  const top = sorted.slice(0, 10);
  const remaining = sorted.length - top.length;

  const totalValue = formatMoney(context.inventorySummary.totalValue, context.business.currency, locale);
  const totalUnits = formatNumber(context.inventorySummary.totalUnits, locale);

  const header = `Stock actual — ${totalUnits} unidades · ${totalValue}:`;

  const lines = top.map((p) =>
    `· ${p.name}: ${formatNumber(p.stock, locale)} u.`
  );

  return [
    header,
    ...lines,
    ...(remaining > 0 ? [`...y ${remaining} productos más.`] : []),
  ].join("\n");
}

