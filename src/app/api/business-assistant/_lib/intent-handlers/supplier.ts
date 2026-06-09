import { NextResponse } from "next/server";
import {
  resolveSupplierCreateRequest,
  resolveSupplierEditRequest,
} from "../handlers/suppliers";
import type { CompoundAction, IntentHandler } from "./types";

// Deterministic confirmation prompt for edit_supplier success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, actualicé el proveedor" before the user confirms the modal.
function buildEditSupplierConfirmPrompt(
  supplierName: string,
  field: string,
  value: string,
): string {
  const fieldLabel =
    field === "phone"
      ? "el teléfono"
      : field === "email"
      ? "el email"
      : field === "name"
      ? "el nombre"
      : field === "contactName"
      ? "el contacto"
      : `el campo ${field}`;
  return `Te paso a confirmar la actualización: ${fieldLabel} de ${supplierName} a ${value}.`;
}

// Handles `edit_supplier`: delegates to the supplier resolver and returns a
// clarification response if the supplier match is ambiguous.

export const handleEditSupplier: IntentHandler = ({ text, safeIntent, parsed, fullCatalogSuppliers }) => {
  if (safeIntent !== "edit_supplier") return null;

  const editResolution = resolveSupplierEditRequest(text, parsed, fullCatalogSuppliers);
  if ("clarification" in editResolution) {
    return NextResponse.json(editResolution.clarification);
  }
  const action = editResolution.action;
  return {
    answer: buildEditSupplierConfirmPrompt(action.supplier.name, action.field, action.value),
    primaryAction: action as CompoundAction,
  };
};

// Deterministic confirmation prompt for create_supplier success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, agregué el proveedor" before the user confirms the modal.
function buildCreateSupplierConfirmPrompt(supplierName: string): string {
  return `Te paso a confirmar el alta del proveedor ${supplierName}.`;
}

// Handles `create_supplier`: emits a minimal prompt if the resolver couldn't
// extract a supplier name; otherwise returns the create action.

export const handleCreateSupplier: IntentHandler = ({ text, safeIntent, parsed }) => {
  if (safeIntent !== "create_supplier") return null;

  let supplierCreateResolution;
  try {
    supplierCreateResolution = resolveSupplierCreateRequest(text, parsed);
  } catch {
    return NextResponse.json({ answer: "No pude procesar los datos del proveedor. Indicá el nombre para continuar." });
  }

  if (supplierCreateResolution?.action) {
    const action = supplierCreateResolution.action;
    return {
      answer: buildCreateSupplierConfirmPrompt(action.supplier.name),
      primaryAction: action as CompoundAction,
    };
  }
  return NextResponse.json({ answer: "¿Cuál es el nombre del proveedor que querés agregar?", inputHint: "Ej: Distribuidora ABC" });
};
