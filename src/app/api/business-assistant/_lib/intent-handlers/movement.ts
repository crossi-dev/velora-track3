import { NextResponse } from "next/server";
import { normalizeActionText } from "../shared";
import { buildConfirmationRequest } from "../confirmation";
import type { IntentHandler } from "./types";

const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  purchase: "compra",
  tax: "impuesto",
  salary: "sueldo",
  adjustment: "ajuste",
  income: "ingreso",
  // "withdrawal" = sangría / retiro de efectivo de caja.
  // Previously "retiro" mapped to "adjustment", which corrupted caja reports by mixing
  // intentional cash-out events with generic adjustments. Fixed 2026-06-03.
  withdrawal: "retiro",
};

const ALLOWED_MOVEMENT_TYPES = new Set(["purchase", "tax", "salary", "adjustment", "income", "withdrawal"] as const);
type AllowedMovementType = "purchase" | "tax" | "salary" | "adjustment" | "income" | "withdrawal";

const MOVEMENT_TYPE_ES_TO_EN: Record<string, string> = {
  gasto: "purchase", ingreso: "income", retiro: "withdrawal", sangria: "withdrawal", sueldo: "salary", otro: "adjustment",
};

// Deterministic confirmation prompt for register_movement success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, registré el movimiento" before the user confirms the modal.
function buildRegisterMovementConfirmPrompt(
  typeLabel: string,
  amountLabel: string,
  description: string,
): string {
  const descSuffix = description ? ` (${description})` : "";
  return `Te paso a confirmar el registro de ${typeLabel} por ${amountLabel}${descSuffix}.`;
}

// Handles `register_movement`: cashflow writes must be user-confirmed
// before hitting the DB. AI extraction of amount/type/description can go
// wrong in ways that silently corrupt the cashbook, so we always route
// through a confirmation card — same gate pattern as adjust_stock and
// edit_product.
export const handleRegisterMovement: IntentHandler = ({ safeIntent, parsed }) => {
  if (safeIntent !== "register_movement") return null;

  if (!parsed.movementDraft) {
    return NextResponse.json({ answer: "¿De qué tipo es el movimiento y por cuánto? Ej: pagué $5000 de luz." });
  }

  const rawType = normalizeActionText(parsed.movementDraft.movementType) ?? "";
  const movementType = MOVEMENT_TYPE_ES_TO_EN[rawType] ?? rawType;
  const movementAmount = Number(parsed.movementDraft.amount);
  const movementDescription = normalizeActionText(parsed.movementDraft.description) ?? "";

  if (!movementType || !ALLOWED_MOVEMENT_TYPES.has(movementType as AllowedMovementType)) {
    return NextResponse.json({ answer: "No reconocí el tipo de movimiento. Indicá si es una compra, impuesto, sueldo, ingreso o ajuste." });
  }

  if (!Number.isFinite(movementAmount) || movementAmount === 0) {
    return NextResponse.json({ answer: "¿De cuánto es el movimiento? Indicá el monto (ej: $5000)." });
  }

  const typeLabel = MOVEMENT_TYPE_LABEL[movementType] ?? movementType;
  const amountLabel = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(movementAmount);

  return NextResponse.json({
    answer: buildRegisterMovementConfirmPrompt(typeLabel, amountLabel, movementDescription),
    confirmationRequest: buildConfirmationRequest({
      severity: "warning",
      title: "Confirmar movimiento",
      message: `¿Registrar ${typeLabel} por ${amountLabel} — ${movementDescription}?`,
      action: {
        type: "register_movement",
        movement: {
          movementType: movementType as AllowedMovementType,
          amount: movementAmount,
          description: movementDescription,
        },
      },
    }),
  });
};
