"use client";

import { useState } from "react";
import { Trash as TrashIcon } from "@phosphor-icons/react";
import type { ContactRow } from "@/domain";
import { normalizePersonOrBusinessName } from "../lib/helpers";
import { BottomSheet } from "./BottomSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LABEL_STYLE, LABEL_TEXT_STYLE } from "./form-field-styles";

const UTILITY_TEXT_BUTTON_STYLE = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.875rem",
  padding: "12px 16px",
  minHeight: "44px",
} as const;

type SupplierPatch = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  leadTimeDays?: number | null;
};

export interface SupplierDetailSheetProps {
  row: ContactRow;
  supplierDrafts: Record<string, { name: string; phone: string; email: string; contactName: string; leadTimeDays: string }>;
  setSupplierDrafts: (updater: (current: Record<string, { name: string; phone: string; email: string; contactName: string; leadTimeDays: string }>) => Record<string, { name: string; phone: string; email: string; contactName: string; leadTimeDays: string }>) => void;
  savingContactId: string | null;
  savedContactId: string | null;
  errorContactId: string | null;
  pendingDeleteId: string | null;
  deletingId: string | null;
  onClose: () => void;
  onSaveAll: (id: string, patch: SupplierPatch, label: string) => Promise<void>;
  onRequestDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  t: (en: string, es: string) => string;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function SupplierDetailSheet({
  row,
  supplierDrafts,
  setSupplierDrafts,
  savingContactId,
  savedContactId,
  errorContactId,
  pendingDeleteId,
  deletingId,
  onClose,
  onSaveAll,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  t,
}: SupplierDetailSheetProps) {
  const storedDraft = supplierDrafts[row.id];
  const [name, setName] = useState(storedDraft?.name ?? normalizePersonOrBusinessName(row.name));
  const [contactName, setContactName] = useState(storedDraft?.contactName ?? row.contactName ?? "");
  const [phone, setPhone] = useState(storedDraft?.phone ?? row.phone ?? "");
  const [email, setEmail] = useState(storedDraft?.email ?? row.email ?? "");
  const [leadTimeDays, setLeadTimeDays] = useState(storedDraft?.leadTimeDays ?? String(row.leadTimeDays ?? ""));
  const [nameError, setNameError] = useState<string | null>(null);

  const isSaving = savingContactId === row.id;

  function syncDraft() {
    setSupplierDrafts((c) => ({
      ...c,
      [row.id]: { ...( c[row.id] ?? {}), name, contactName, phone, email, leadTimeDays },
    }));
  }

  async function handleSave() {
    if (isSaving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(t("Name is required.", "El nombre es obligatorio."));
      return;
    }
    setNameError(null);
    syncDraft();
    const parsedLeadTime = leadTimeDays.trim() === "" ? null : parseInt(leadTimeDays, 10);
    const rowLeadTime = row.leadTimeDays ?? null;
    const patch: SupplierPatch = {
      name: trimmedName !== (row.name ?? "").trim() ? trimmedName : undefined,
      phone: phone !== (row.phone ?? "") ? phone : undefined,
      email: email !== (row.email ?? "") ? email : undefined,
      contactName: contactName !== (row.contactName ?? "") ? contactName : undefined,
      leadTimeDays: parsedLeadTime !== rowLeadTime ? parsedLeadTime : undefined,
    };
    const hasChanges = Object.values(patch).some((v) => v !== undefined);
    if (!hasChanges) return;
    await onSaveAll(row.id, patch, trimmedName);
  }

  return (
    <BottomSheet open onClose={onClose} ariaLabel={row.name} title={row.name} t={t}>
      <div className="flex flex-col gap-2 mb-4">
        <label style={LABEL_STYLE}>
          <span style={LABEL_TEXT_STYLE}>{t("Supplier name", "Nombre del proveedor")}</span>
          <Input
            type="text"
            value={name}
            onChange={(e) => { setName(e.currentTarget.value); setNameError(null); }}
            disabled={isSaving}
            className="font-semibold"
            aria-required="true"
          />
        </label>
        {nameError && (
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>{nameError}</p>
        )}
        <label style={LABEL_STYLE}>
          <span style={LABEL_TEXT_STYLE}>{t("Contact name", "Nombre de contacto")}</span>
          <Input
            type="text"
            value={contactName}
            onChange={(e) => setContactName(e.currentTarget.value)}
            disabled={isSaving}
          />
        </label>
        <label style={LABEL_STYLE}>
          <span style={LABEL_TEXT_STYLE}>{t("Phone / WhatsApp", "Tel / WhatsApp")}</span>
          <Input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.currentTarget.value)}
            disabled={isSaving}
          />
        </label>
        <label style={LABEL_STYLE}>
          <span style={LABEL_TEXT_STYLE}>{t("Email", "Mail")}</span>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            disabled={isSaving}
          />
        </label>
        <label style={LABEL_STYLE}>
          <span style={LABEL_TEXT_STYLE}>{t("Lead time (days)", "Demora de entrega (días)")}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            value={leadTimeDays}
            onChange={(e) => setLeadTimeDays(e.currentTarget.value)}
            disabled={isSaving}
          />
        </label>

        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={isSaving}
          className="mt-1 w-full"
        >
          {isSaving ? t("Saving…", "Guardando…") : t("Save", "Guardar")}
        </Button>

        {savedContactId === row.id && savingContactId !== row.id && errorContactId !== row.id && (
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--success)", fontWeight: 600, textAlign: "center" }}>
            {t("Saved ✓", "Guardado ✓")}
          </p>
        )}
        {errorContactId === row.id && (
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>
            {t("Error saving", "Error al guardar")}
          </p>
        )}
      </div>

      <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 700, marginBottom: "8px" }}>
        {t("Order history", "Historial de pedidos")}
      </p>
      <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)" }}>
        {t("No order history yet.", "Sin historial de pedidos aún.")}
      </p>

      <div style={{ borderTop: "1px solid var(--border)", marginTop: "16px", paddingTop: "16px" }}>
        {pendingDeleteId === row.id ? (
          <div className="flex items-center gap-2">
            <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)", flex: 1 }}>
              {t("Delete this supplier?", "¿Eliminar este proveedor?")}
            </p>
            <button type="button" onClick={() => onConfirmDelete(row.id)} disabled={deletingId === row.id} style={{ ...UTILITY_TEXT_BUTTON_STYLE, color: "var(--danger)", fontWeight: 700, padding: "8px 12px" }}>
              {deletingId === row.id ? "…" : t("Yes, delete", "Sí, eliminar")}
            </button>
            <button type="button" onClick={onCancelDelete} style={{ ...UTILITY_TEXT_BUTTON_STYLE, color: "var(--tone-muted)", padding: "8px 12px" }}>
              {t("Cancel", "Cancelar")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onRequestDelete(row.id)}
            className="text-caption flex items-center gap-1.5"
            style={{ ...UTILITY_TEXT_BUTTON_STYLE, color: "var(--danger)", padding: 0 }}
          >
            <TrashIcon className="icon-xs" strokeWidth={1.8} aria-hidden />
            {t("Delete supplier", "Eliminar proveedor")}
          </button>
        )}
      </div>
    </BottomSheet>
  );
}
