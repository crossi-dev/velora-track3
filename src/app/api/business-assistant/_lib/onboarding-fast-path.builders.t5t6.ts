// Builders for T5 product-input/stock loop and T6 (MP OAuth) turns.
// Split from onboarding-fast-path.builders.ts to keep that file under 300 LOC.
// All builders are pure — no context reads, no DB writes.

import { T6_CHIPS, T5B_CHIPS } from "./onboarding-fast-path.chips";
import type { FastPathResult } from "./onboarding-fast-path.builders";
import type { T5Choice } from "./onboarding-fast-path.parsers";
import type { T5ProductInput } from "./onboarding-fast-path.product-parser";

/**
 * T5 bulk product import: N productos cargados a la vez.
 * Emite intent `create_products_bulk_onboarding` con array de productos.
 * @param products - parsed product list
 * @param skipped - number of input lines that could not be parsed (0 = clean paste)
 *
 * Bulk imports skip the per-product stock loop and create everything at
 * quantity 0. The owner is told explicitly so they know to ajust stock
 * later from the inventory tab instead of being silently dropped into
 * the stock prompt for just the last item.
 */
export function buildBulkProductInputResult(
  products: T5ProductInput[],
  skipped: number,
): FastPathResult {
  const skipNote = skipped > 0
    ? ` (${skipped} ${skipped === 1 ? "línea no reconocida, la salté" : "líneas no reconocidas, las salté"})`
    : "";
  const plural = products.length === 1 ? "producto" : "productos";
  return {
    answer: `Listo, cargué ${products.length} ${plural} con stock 0.${skipNote} Los ajustás cuando los cuentes desde Inventario. ¿Querés decirme una venta o seguimos con el siguiente paso?`,
    actions: [{
      intent: "create_products_bulk_onboarding",
      data: { products },
      summary: `${products.length} productos del onboarding en bulk`,
    }],
    chips: null,
    matchedTurn: 5,
  };
}

/** T5 product input: producto creado server-side, pregunta stock inicial (T5c). */
export function buildT5ProductInputResult(name: string, price: number): FastPathResult {
  return {
    answer: `Listo, ${name} a $${price}. ¿Cuántas unidades tenés hoy?`,
    actions: [{
      intent: "create_product_onboarding",
      data: { name, price, stock: 0 },
      summary: "Producto del onboarding creado",
    }],
    chips: null,
    matchedTurn: 5,
  };
}

/** T5c: stock inicial cargado, preguntar si carga otro o termina. */
export function buildT5bResult(productId: string, productName: string, quantity: number): FastPathResult {
  const answer = quantity === 0
    ? `Listo, ${productName} sin stock por ahora. ¿Cargás otro producto o ya está?`
    : `Agregadas ${quantity} unidades de ${productName}. ¿Cargás otro producto o ya está?`;
  return {
    answer,
    actions: [{
      intent: "adjust_stock",
      data: { productId, productName, mode: "set", quantity },
      summary: "Stock inicial cargado",
    }],
    chips: T5B_CHIPS,
    matchedTurn: 6,
  };
}

/** T5d: el dueño decide continuar cargando otro producto. */
export function buildT5dContinueResult(): FastPathResult {
  return {
    answer: "Dale, decime el siguiente producto: nombre y precio.",
    actions: [{
      intent: "clear_pending_stock_product",
      data: {},
      summary: "Pendiente de stock limpiado — carga otro producto",
    }],
    chips: null,
    matchedTurn: 6,
  };
}

/** T5d: el dueño termina el onboarding de carga de productos. */
export function buildT5dFinishResult(): FastPathResult {
  return {
    answer: "Listo, ya podés empezar a vender. Decime una venta o lo que necesites.",
    actions: [{
      intent: "clear_pending_stock_product",
      data: { markOnboardingComplete: true },
      summary: "Onboarding de carga de productos completado",
    }],
    chips: null,
    matchedTurn: 6,
  };
}

/** T6 prompt — shown first time the dueño reaches this turn (no input matched yet). */
export function buildT6Prompt(): FastPathResult {
  return {
    answer: "Último paso: conectá tu cuenta de Mercado Pago para cobrar con QR. Tocá el botón y autorizás en 10 segundos.",
    actions: [],
    chips: T6_CHIPS,
    matchedTurn: 7,
  };
}

export function buildT6ConnectResult(): FastPathResult {
  return {
    answer: "Te llevo a Mercado Pago, autorizá y volvés acá.",
    actions: [],
    chips: null,
    clientAction: "open_mp_oauth",
    matchedTurn: 7,
  };
}

export function buildT6DeferResult(): FastPathResult {
  return {
    answer: "Ok, lo conectás cuando quieras desde Ajustes → Mercado Pago. ¡Listo el onboarding!",
    actions: [{
      intent: "update_business_setup",
      data: { field: "mercadoPagoOnboardingDeferred", value: true },
      summary: "Conexión MP diferida por el dueño",
    }],
    chips: null,
    matchedTurn: 7,
  };
}

/** T5 (catalog mode choice): routes to foto/archivo/voz/manual flow. */
export function buildT5Result(choice: T5Choice): FastPathResult {
  if (choice === "foto") {
    return {
      answer: "Dale, sacale una foto al cuaderno o las etiquetas. Te abro la cámara.",
      actions: [{
        intent: "open_photo_picker",
        data: {},
        summary: "Abrir cámara para foto de cuaderno",
      }],
      chips: null,
      clientAction: "open_photo_picker",
      clientActionParams: { context: "products" },
      matchedTurn: 5,
    };
  }
  if (choice === "archivo") {
    return {
      answer: "Dale, tirá tu Excel o CSV acá. Lee hasta 500 filas con columnas nombre y precio (cantidad opcional).",
      actions: [{
        intent: "open_file_picker",
        data: {},
        summary: "Abrir selector de archivo Excel/CSV",
      }],
      chips: null,
      clientAction: "open_file_picker",
      matchedTurn: 5,
    };
  }
  if (choice === "voz") {
    return {
      answer: "Dale, tocá el micrófono y dictame el primer producto. Ej: 'alfajor 500'.",
      actions: [],
      chips: null,
      matchedTurn: 5,
    };
  }
  return {
    answer: "Dale, decime el primer producto: nombre y precio. Ej: 'alfajor 500'.",
    actions: [],
    chips: null,
    matchedTurn: 5,
  };
}

