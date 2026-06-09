import { normalizeForMatching } from "./shared";
import type { AssistantDestructiveAction } from "@/app/dashboard/lib/assistant-action.types";

export function looksLikeUndoRequest(text: string): { target: "sale" | "customer" | "stock"; count: number } | null {
  const normalized = normalizeForMatching(text);

  const undoSpecificVerbs = ["deshacer", "deshace", "deshaceme", "anula", "anular", "anulo", "cancela", "cancelar", "cancelo"];
  const genericDeleteVerbs = ["borra", "borrar", "borro", "elimina", "eliminar", "quita", "quitar", "saca", "sacalo", "sacame", "sacala", "sacar", "tira", "tirar", "tiro"];
  const undoQualifiers = ["ultima", "ultimas", "ultimo", "ultimos", "anterior", "anteriores", "previa", "previas", "previo", "previos"];
  const bulkQualifiers = ["todo", "todos", "todas", "toda"];

  const hasUndoSpecificVerb = undoSpecificVerbs.some((t) => normalized.includes(t));
  const hasGenericDeleteVerb = genericDeleteVerbs.some((t) => normalized.includes(t));
  const hasUndoQualifier = undoQualifiers.some((t) => normalized.includes(t));
  const hasBulkQualifier = bulkQualifiers.some((t) => normalized.includes(t));

  // "borra todos los items del stock" is a bulk-delete request, NOT an undo.
  // Defer to the model (which routes to delete_product / answer).
  if (hasBulkQualifier && !hasUndoSpecificVerb) return null;

  // Generic verbs ("borra", "elimina") need an undo qualifier ("última", "anterior").
  // Without it the user probably means delete-product, not undo.
  if (!hasUndoSpecificVerb && !(hasGenericDeleteVerb && hasUndoQualifier)) return null;

  const spanishNumbers: Record<string, number> = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
  const countMatch = normalized.match(/\b(\d+)\b/);
  const wordMatch = normalized.match(/\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/);
  let count = 1;
  if (countMatch) count = Math.max(1, parseInt(countMatch[1], 10));
  else if (wordMatch) count = spanishNumbers[wordMatch[1]] ?? 1;

  let target: "sale" | "customer" | "stock" | null = null;
  if (["venta", "ventas", "factura", "facturas"].some((t) => normalized.includes(t))) {
    target = "sale";
  } else if (["cliente", "clientes"].some((t) => normalized.includes(t))) {
    target = "customer";
  } else if (["stock", "inventario", "item", "carga", "cargas", "ingreso", "ingresos"].some((t) => normalized.includes(t))) {
    target = "stock";
  } else if (["movimiento", "movimientos"].some((t) => normalized.includes(t))) {
    // H2 fix — JD adversarial review Step 1, 2026-05-28.
    // "movimiento" is ambiguous: Velora has both CashMovement and StockMovement.
    // "anulá el movimiento de caja" → cash context (must NOT resolve to stock).
    // Only assign stock target when a stock-context qualifier is also present.
    // Bare "movimiento" or "movimiento de caja" falls through to LLM disambiguation.
    const hasStockQualifier = /\b(de\s+stock|de\s+inventario|de\s+ingreso)\b/.test(normalized);
    if (hasStockQualifier) {
      target = "stock";
    }
    // else: leave target = null → LLM handles disambiguation
  }

  if (target) return { target, count };

  // Bare "deshacer" / "anula" / "cancela" with no explicit target defaults to
  // the most recent sale — the most common undo case. Without this default the
  // message slipped past every fast-path and ended up in the welcome fallback.
  // Generic delete verbs ("borra", "elimina") with an undo qualifier ("último",
  // "anterior") also default to "sale" — e.g. "borrá lo último" is unambiguously
  // a request to undo the last action, not to delete a product (which would use
  // "borrar producto X" or "sacá X del catálogo"). Without this, "borrá lo último"
  // returns null and falls through to the LLM which replies with a bare "Hecho.".
  if (hasUndoSpecificVerb || (hasGenericDeleteVerb && hasUndoQualifier)) {
    return { target: "sale", count };
  }

  return null;
}

// Server-emitted confirmation cards use a subset of AssistantDestructiveAction.
// Sourcing the type from one place prevents the kind of drift that hit us
// when "set" was added to BulkPriceDirection and 3 separate definitions had
// to be kept in sync manually.
type ServerConfirmationAction = Extract<
  AssistantDestructiveAction,
  { type: "register_sale" | "register_sale_with_new_customer" | "delete_product" | "undo" | "adjust_stock" | "bulk_price_update" | "register_movement" | "create_purchase_request" | "create_product" | "create_budget" }
>;

export function buildConfirmationRequest(args: {
  severity: "warning" | "critical";
  title: string;
  message: string;
  action: ServerConfirmationAction;
}) {
  return {
    id: crypto.randomUUID(),
    severity: args.severity,
    title: args.title,
    message: args.message,
    confirmLabel: "Confirmar",
    cancelLabel: "Cancelar",
    action: args.action,
  };
}
