// Copy + label for the product-delete confirmation. Pure function so the
// branching logic is unit-testable without mounting the sheet component.
//
// Filosofía (PRODUCT_BIBLE.md): el dueño decide. Si el producto tiene
// ventas registradas, le decimos qué consecuencia tiene la acción y le
// dejamos confirmar — no bloqueamos. Tono neutro, sin colores alarmantes.

export interface ProductDeleteConfirmCopy {
  message: string;
  confirmLabel: string;
  /**
   * true cuando el aviso es por ventas asociadas — el ProductDetailSheet
   * lo usa para neutralizar colores (sin rojo alarmante).
   */
  neutralTone: boolean;
}

export function buildProductDeleteConfirmCopy(hasSales: boolean): ProductDeleteConfirmCopy {
  if (hasSales) {
    return {
      message: "Este producto tiene ventas registradas. ¿Borrarlo igual?",
      confirmLabel: "Borrar",
      neutralTone: true,
    };
  }
  return {
    message: "¿Eliminar este producto?",
    confirmLabel: "Sí, eliminar",
    neutralTone: false,
  };
}
