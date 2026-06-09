import type { AssistantIntent, AssistantTaskModelResponse } from "./types";
import { normalizeActionText } from "./shared";
import { validateMovementAmount, validateMovementDescription } from "@/domain/rules";

interface ValidationResult {
  valid: boolean;
  reason?: string;
  clarification?: { answer: string; inputHint?: string };
}

function isFinitePositive(value: unknown): boolean {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) && n > 0;
}

/**
 * Central parsed-action validator. Runs AFTER model.ts parses the AI response
 * and BEFORE route.ts dispatches to intent handlers.
 *
 * Returns { valid: true } if the payload is structurally safe to dispatch.
 * Returns { valid: false, reason, clarification } if the payload is malformed.
 */
export function validateParsedAction(
  intent: AssistantIntent,
  parsed: AssistantTaskModelResponse
): ValidationResult {
  switch (intent) {
    case "register_sale": {
      const items = parsed.saleDraft?.items;
      const hasItems = Array.isArray(items) && items.some((it) => normalizeActionText(it?.productName));
      const hasMatched = !!normalizeActionText(parsed.matchedProductId);
      const hasProductName = !!normalizeActionText(parsed.product?.name);
      if (!hasItems && !hasMatched && !hasProductName) {
        return {
          valid: false,
          reason: "missing_sale_target",
          clarification: { answer: "¿Qué producto vendiste?", inputHint: "Ej: 3 remeras a 2500" },
        };
      }
      return { valid: true };
    }

    case "register_movement": {
      const type = normalizeActionText(parsed.movementDraft?.movementType);
      const amount = parsed.movementDraft?.amount;
      const desc = normalizeActionText(parsed.movementDraft?.description);
      if (!type) {
        return {
          valid: false,
          reason: "missing_movement_type",
          clarification: { answer: "¿Qué tipo de movimiento es?", inputHint: "Ej: gasto, ingreso, sueldo" },
        };
      }
      if (validateMovementAmount(Number(amount)) !== null) {
        return {
          valid: false,
          reason: "missing_movement_amount",
          clarification: { answer: "¿Cuál es el monto del movimiento?", inputHint: "Ej: 5000" },
        };
      }
      if (validateMovementDescription(desc ?? "") !== null) {
        return {
          valid: false,
          reason: "missing_movement_description",
          clarification: { answer: "¿Cuál es la descripción del movimiento?", inputHint: "Ej: pago de luz" },
        };
      }
      return { valid: true };
    }

    case "stock_load": {
      const single = parsed.stockDraft;
      const multi = parsed.stockDrafts;
      const hasSingleDraft = single?.itemName || single?.quantity != null;
      const hasMultiDrafts = Array.isArray(multi) && multi.length > 0;
      if (!hasSingleDraft && !hasMultiDrafts) {
        return {
          valid: false,
          reason: "missing_stock_data",
          clarification: { answer: "¿Qué producto querés cargar y en qué cantidad?", inputHint: "Ej: 50 clavos a $200" },
        };
      }
      // Reject explicit non-finite or non-positive quantities (NaN strings, 0, negative).
      // Absent quantities pass — handler asks the user for it.
      if (single?.quantity != null && !isFinitePositive(single.quantity)) {
        return {
          valid: false,
          reason: "invalid_stock_quantity",
          clarification: { answer: "¿Cuántas unidades querés cargar?", inputHint: "Ej: 50" },
        };
      }
      if (Array.isArray(multi)) {
        for (const row of multi) {
          if (row?.quantity != null && !isFinitePositive(row.quantity)) {
            return {
              valid: false,
              reason: "invalid_stock_quantity",
              clarification: { answer: "¿Cuántas unidades de cada producto?", inputHint: "Ej: 50 clavos, 20 tornillos" },
            };
          }
        }
      }
      return { valid: true };
    }

    case "adjust_stock": {
      // Handler has its own granular validation (missing_product, missing_quantity, missing_mode)
      // Validator catches the case where there's no adjustment data at all
      const mode = normalizeActionText(parsed.stockAdjustment?.mode);
      const qty = parsed.stockAdjustment?.quantity;
      const productName = normalizeActionText(parsed.product?.name);
      const matchedId = normalizeActionText(parsed.matchedProductId);
      if (!mode && (qty === null || qty === undefined) && !productName && !matchedId) {
        return {
          valid: false,
          reason: "missing_adjustment_data",
          clarification: { answer: "¿Cómo querés ajustar el stock? Decime producto, cantidad y operación.", inputHint: "Ej: sumar 5 clavos" },
        };
      }
      return { valid: true };
    }

    case "edit_product": {
      const hasField = normalizeActionText(parsed.productEdit?.field);
      const hasMulti = Array.isArray(parsed.productEdits) && parsed.productEdits.length > 0;
      if (!hasField && !hasMulti && !normalizeActionText(parsed.product?.name)) {
        return {
          valid: false,
          reason: "missing_product_edit_data",
          clarification: { answer: "¿Qué producto querés editar y qué campo?", inputHint: "Ej: cambiar precio de Filtro a 2000" },
        };
      }
      return { valid: true };
    }

    case "create_customer": {
      const name = normalizeActionText(parsed.customer?.name);
      const phone = normalizeActionText(parsed.customer?.phone);
      const email = normalizeActionText(parsed.customer?.email);
      const taxId = normalizeActionText(parsed.customer?.taxId);
      if (!name && !phone && !email && !taxId) {
        return {
          valid: false,
          reason: "missing_customer_data",
          clarification: { answer: "¿Algún dato del cliente? Nombre, teléfono o email sirve.", inputHint: "Ej: Juan Pérez o 1100000000" },
        };
      }
      return { valid: true };
    }

    case "create_supplier": {
      const name = normalizeActionText(parsed.supplier?.name);
      if (!name) {
        return {
          valid: false,
          reason: "missing_supplier_name",
          clarification: { answer: "¿Cuál es el nombre del proveedor?", inputHint: "Ej: Distribuidora ABC" },
        };
      }
      return { valid: true };
    }

    case "delete_product": {
      const hasMulti = Array.isArray(parsed.productDeletes) &&
        parsed.productDeletes.some((d) => normalizeActionText(d?.productName));
      const hasSingle = !!normalizeActionText(parsed.product?.name) ||
        !!normalizeActionText(parsed.matchedProductId);
      if (!hasMulti && !hasSingle) {
        return {
          valid: false,
          reason: "missing_delete_target",
          clarification: { answer: "¿Qué producto querés eliminar?", inputHint: "Ej: borrá clavo 2 pulgadas" },
        };
      }
      return { valid: true };
    }

    case "bulk_price_update": {
      const update = parsed.bulkPriceUpdate;
      if (!update || !isFinitePositive(update.amount) || !update.mode || !update.direction) {
        return {
          valid: false,
          reason: "missing_bulk_price_data",
          clarification: { answer: "¿Cómo querés ajustar los precios?", inputHint: "Ej: subí todos los precios 10%" },
        };
      }
      return { valid: true };
    }

    case "edit_customer": {
      const hasTarget = !!normalizeActionText(parsed.matchedCustomerId) ||
        !!normalizeActionText(parsed.customer?.name);
      if (!hasTarget) {
        return {
          valid: false,
          reason: "missing_customer_target",
          clarification: { answer: "¿Qué cliente querés editar?", inputHint: "Ej: editá el teléfono de Juan Pérez" },
        };
      }
      return { valid: true };
    }

    case "edit_supplier": {
      const hasTarget = !!normalizeActionText(parsed.matchedSupplierId) ||
        !!normalizeActionText(parsed.supplier?.name);
      if (!hasTarget) {
        return {
          valid: false,
          reason: "missing_supplier_target",
          clarification: { answer: "¿Qué proveedor querés editar?", inputHint: "Ej: editá el email de Distribuidora ABC" },
        };
      }
      return { valid: true };
    }

    case "delete_supplier": {
      const hasTarget = !!normalizeActionText(parsed.matchedSupplierId) ||
        !!normalizeActionText(parsed.supplier?.name);
      if (!hasTarget) {
        return {
          valid: false,
          reason: "missing_supplier_target",
          clarification: { answer: "¿Qué proveedor querés eliminar?", inputHint: "Ej: borrá el proveedor Distribuidora ABC" },
        };
      }
      return { valid: true };
    }

    case "create_purchase_request": {
      const itemName = normalizeActionText(parsed.purchaseRequestDraft?.items?.[0]?.itemName);
      if (!itemName) {
        return {
          valid: false,
          reason: "missing_purchase_item",
          clarification: { answer: "¿Qué ítem querés pedir? Ej: 50 kilos de harina.", inputHint: "Ej: 50 kilos de harina" },
        };
      }
      return { valid: true };
    }

    case "business_query":
    case "answer":
    case "report_event":
      return { valid: true };

    default:
      return { valid: true };
  }
}
