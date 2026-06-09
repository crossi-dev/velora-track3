// Builders de confirmation cards para acciones de alto riesgo del owner.
// Extraído de owner-handler.ts para respetar el límite de 300 líneas y
// porque las plantillas son lógica pura sin dependencias.

import type { CompoundAction } from "./intent-handlers/types";

export function buildRiskConfirmationRequest(action: CompoundAction): Record<string, unknown> | null {
  const id = `risk-${Date.now()}`;
  if (action.type === "delete_product") return {
    id, severity: "critical", title: "Eliminar producto",
    message: `¿Confirmás eliminar "${action.product.name}"? Esta acción no se puede deshacer.`,
    confirmLabel: "Sí, eliminar", cancelLabel: "Cancelar",
    action: { type: "delete_product", product: action.product },
  };
  if (action.type === "delete_supplier") return {
    id, severity: "critical", title: "Eliminar proveedor",
    message: `¿Confirmás eliminar el proveedor "${action.supplier.name}"? Esta acción no se puede deshacer.`,
    confirmLabel: "Sí, eliminar", cancelLabel: "Cancelar",
    action: { type: "delete_supplier", supplier: action.supplier },
  };
  if (action.type === "delete_customer") return {
    id, severity: "critical", title: "Eliminar cliente",
    message: `¿Confirmás eliminar al cliente "${action.customer.name}"? Esta acción no se puede deshacer.`,
    confirmLabel: "Sí, eliminar", cancelLabel: "Cancelar",
    action: { type: "delete_customer", customer: action.customer },
  };
  if (action.type === "bulk_price_update") {
    const dir = action.direction === "up" ? "subir" : action.direction === "down" ? "bajar" : "fijar";
    const amt = action.mode === "percentage" ? `${action.amount}%` : `$${action.amount}`;
    const tgt = action.targetLabel ? `"${action.targetLabel}"` : "todos los productos";
    return {
      id, severity: "warning", title: "Actualización masiva de precios",
      message: `¿Confirmás ${dir} el precio de ${tgt} en ${amt}?`,
      confirmLabel: "Sí, actualizar", cancelLabel: "Cancelar",
      action: { type: "bulk_price_update", amount: action.amount, mode: action.mode, direction: action.direction, productIds: action.productIds, targetLabel: action.targetLabel },
    };
  }
  if (action.type === "adjust_stock") {
    const modeStr = action.mode === "set" ? `a ${action.quantity}` : action.mode === "increase" ? `en +${action.quantity}` : `en -${action.quantity}`;
    return {
      id, severity: "warning", title: "Ajuste de stock",
      message: `¿Confirmás ajustar el stock de "${action.product.name}" ${modeStr}?`,
      confirmLabel: "Sí, ajustar", cancelLabel: "Cancelar",
      action: { type: "adjust_stock", product: action.product, mode: action.mode, quantity: action.quantity },
    };
  }
  if (action.type === "undo") return {
    id, severity: "warning", title: "Deshacer venta",
    message: `¿Confirmás deshacer ${action.undoCount === 1 ? "la última venta" : `las últimas ${action.undoCount} ventas`}?`,
    confirmLabel: "Sí, deshacer", cancelLabel: "Cancelar",
    action: { type: "undo", undoTarget: action.undoTarget, undoCount: action.undoCount },
  };
  if (action.type === "register_movement") {
    const dir = action.movement.movementType === "income" ? "entrada" : "salida";
    const desc = action.movement.description ? ` "${action.movement.description}"` : "";
    return {
      id, severity: "warning", title: "Movimiento de caja",
      message: `¿Confirmás registrar una ${dir} de $${action.movement.amount}${desc}?`,
      confirmLabel: "Sí, registrar", cancelLabel: "Cancelar",
      action: { type: "register_movement", movement: action.movement },
    };
  }
  return null;
}
