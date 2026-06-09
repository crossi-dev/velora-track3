import { NextResponse } from "next/server";
import {
  resolveCustomerCreateRequest,
  resolveCustomerEditRequest,
} from "../handlers/customers";
import { normalizeForMatching } from "../shared";
import type { CompoundAction, IntentHandler } from "./types";

// Deterministic confirmation prompt for edit_customer success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, actualicé al cliente" before the user confirms the modal.
function buildEditCustomerConfirmPrompt(
  customerName: string,
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
      : field === "taxId"
      ? "el CUIT/CUIL"
      : `el campo ${field}`;
  return `Te paso a confirmar la actualización: ${fieldLabel} de ${customerName} a ${value}.`;
}

// Handles `edit_customer`: delegates to the customer resolver and returns a
// clarification response if the product/customer match is ambiguous.

export const handleEditCustomer: IntentHandler = ({ text, safeIntent, parsed, fullCatalogCustomers }) => {
  if (safeIntent !== "edit_customer") return null;

  const editResolution = resolveCustomerEditRequest(text, parsed, fullCatalogCustomers);
  if ("clarification" in editResolution) {
    return NextResponse.json(editResolution.clarification);
  }
  const action = editResolution.action;
  return {
    answer: buildEditCustomerConfirmPrompt(action.customer.name, action.field, action.value),
    primaryAction: action as CompoundAction,
  };
};

// Handles `delete_customer`: emits a confirmation card (destructive op — never
// executes without explicit user tap). Customer is resolved from the catalog
// snapshot using the diacritic-tolerant findById lookup in the mapper; the
// handler receives the already-resolved CompoundAction from the mapper result
// (via the owner-assistant stage) so it only needs to build the card.
// has_history (customer has sales/invoices) is surfaced as a warm rejection
// message — the use-case enforces it server-side; here we pass through the
// action for the client-side confirmation flow.
//
// Note: unlike delete_product/delete_supplier which use NextResponse.json for
// the confirmation card, this handler returns a HandlerBody with a
// confirmationRequest so it integrates with the owner-assistant stage path
// (which calls respond() and reads the actions array).
export const handleDeleteCustomer: IntentHandler = ({ safeIntent, parsed, fullCatalogCustomers }) => {
  if (safeIntent !== "delete_customer") return null;

  // Extract customer name — from parsed.customer.name (owner-assistant path)
  // or from parsed.matchedCustomerId (supervisor path as fallback).
  const rawName = parsed.customer?.name?.trim() ?? "";
  if (!rawName) {
    return NextResponse.json({
      answer: "¿Qué cliente querés eliminar? Indicá el nombre.",
      inputHint: "Ej: borrar cliente Juan Pérez",
    });
  }

  // Diacritic-tolerant lookup — mirrors the mapper's findById logic.
  const needle = normalizeForMatching(rawName);
  const matched =
    fullCatalogCustomers.find((c) => normalizeForMatching(c.name) === needle) ??
    fullCatalogCustomers.find((c) => normalizeForMatching(c.name).includes(needle)) ??
    fullCatalogCustomers.find((c) => needle.includes(normalizeForMatching(c.name)));

  if (!matched?.id) {
    return NextResponse.json({
      answer: `No encontré un cliente llamado "${rawName}". Revisá el nombre e intentá de nuevo.`,
    });
  }

  return NextResponse.json({
    answer: `¿Eliminar al cliente "${matched.name}"?`,
    confirmationRequest: {
      id: crypto.randomUUID(),
      severity: "critical" as const,
      title: "Eliminar cliente",
      message: `¿Confirmás eliminar al cliente "${matched.name}"? Esta acción no se puede deshacer.`,
      confirmLabel: "Sí, eliminar",
      cancelLabel: "Cancelar",
      action: { type: "delete_customer", customer: { id: matched.id, name: matched.name } },
    },
  });
};

// Handles `create_customer`: builds a deterministic "Listo, agrego a X"
// answer when the resolver has enough fields. Returns a clarification (via
// NextResponse) if the resolver reports missing data.

export const handleCreateCustomer: IntentHandler = ({ text, safeIntent, parsed, locale }) => {
  if (safeIntent !== "create_customer") return null;

  let customerCreateResolution;
  try {
    customerCreateResolution = resolveCustomerCreateRequest(text, parsed, locale, { force: true });
  } catch {
    return NextResponse.json({ answer: "No pude procesar los datos del cliente. Intentá de nuevo con nombre, teléfono o email." });
  }

  if (customerCreateResolution?.action) {
    const c = customerCreateResolution.action.customer as { name?: string; phone?: string; email?: string; taxId?: string };
    const displayName = c.name || c.phone || c.email || "Cliente";
    const parts = [`${displayName} agregado como cliente.`];
    if (c.phone && c.phone !== displayName) parts.push(`Teléfono: ${c.phone}.`);
    if (c.email) parts.push(`Correo: ${c.email}.`);
    if (c.taxId) parts.push(`CUIT/CUIL: ${c.taxId}.`);
    const deterministicAnswer = parts.join(" ");
    return { answer: deterministicAnswer, primaryAction: customerCreateResolution.action as CompoundAction };
  }
  if (customerCreateResolution?.clarification) {
    return NextResponse.json(customerCreateResolution.clarification);
  }
  return null;
};
