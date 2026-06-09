"use client";

import { useState } from "react";
import { Trash as TrashIcon } from "@phosphor-icons/react";
import type { ContactRow, InvoiceStatus } from "@/domain";
import type { InvoiceRecord } from "../lib/types";
import { splitCustomerName, buildCustomerFullName } from "../lib/helpers";
import { getInvoicesForClient, sumInvoiceTotals } from "../lib/invoice-summary";
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

const STATUS_LABEL: Record<InvoiceStatus, { en: string; es: string }> = {
  issued: { en: "Issued", es: "Emitida" },
  sent: { en: "Sent", es: "Enviada" },
  paid: { en: "Paid", es: "Pagada" },
};
const STATUS_COLOR: Record<InvoiceStatus, string> = {
  issued: "var(--tone-muted)",
  sent: "var(--brand)",
  paid: "var(--success)",
};

type ClientPatch = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
  ivaCondition?: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
};

export interface ClientDetailSheetProps {
  row: ContactRow;
  clientDrafts: Record<string, { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string }>;
  setClientDrafts: (updater: (current: Record<string, { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string }>) => Record<string, { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string }>) => void;
  savingContactId: string | null;
  savedContactId: string | null;
  errorContactId: string | null;
  pendingDeleteId: string | null;
  deletingId: string | null;
  invoices: InvoiceRecord[];
  onClose: () => void;
  onSaveAll: (id: string, patch: ClientPatch, label: string) => Promise<void>;
  onRequestDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  moneyFmt: (value: unknown, currency: string) => string;
  formatDate: (value: string) => string;
  t: (en: string, es: string) => string;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function ClientDetailSheet({
  row,
  clientDrafts,
  setClientDrafts,
  savingContactId,
  savedContactId,
  errorContactId,
  pendingDeleteId,
  deletingId,
  invoices,
  onClose,
  onSaveAll,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  moneyFmt,
  formatDate,
  t,
}: ClientDetailSheetProps) {
  const clientInvoices = getInvoicesForClient(row, invoices);
  const totalInvoiced = sumInvoiceTotals(clientInvoices);
  const firstCurrency = clientInvoices[0]?.currency ?? "USD";

  const storedDraft = clientDrafts[row.id];
  const [firstName, setFirstName] = useState(
    storedDraft?.firstName ?? splitCustomerName(row.name).firstName
  );
  const [lastName, setLastName] = useState(
    storedDraft?.lastName ?? splitCustomerName(row.name).lastName
  );
  const [phone, setPhone] = useState(storedDraft?.phone ?? row.phone ?? "");
  const [email, setEmail] = useState(storedDraft?.email ?? row.email ?? "");
  const [taxId, setTaxId] = useState(storedDraft?.taxId ?? row.taxId ?? "");
  const [ivaCondition] = useState(storedDraft?.ivaCondition ?? row.ivaCondition ?? "");
  const [address, setAddress] = useState(storedDraft?.address ?? row.address ?? "");
  const [postalCode, setPostalCode] = useState(storedDraft?.postalCode ?? row.postalCode ?? "");
  const [city, setCity] = useState(storedDraft?.city ?? row.city ?? "");
  const [dni, _setDni] = useState(storedDraft?.dni ?? "");
  const [nameError, setNameError] = useState<string | null>(null);

  const isSaving = savingContactId === row.id;

  function syncDraft() {
    setClientDrafts((c) => ({
      ...c,
      [row.id]: { firstName, lastName, phone, email, taxId, ivaCondition, address, postalCode, city, dni },
    }));
  }

  async function handleSave() {
    if (isSaving) return;
    const fullName = buildCustomerFullName(firstName, lastName);
    if (!fullName.trim()) {
      setNameError(t("Name is required.", "El nombre es obligatorio."));
      return;
    }
    setNameError(null);
    syncDraft();
    const patch: ClientPatch = {
      name: fullName !== row.name ? fullName : undefined,
      phone: phone !== (row.phone ?? "") ? phone : undefined,
      email: email !== (row.email ?? "") ? email : undefined,
      taxId: taxId !== (row.taxId ?? "") ? taxId : undefined,
      address: address !== (row.address ?? "") ? address : undefined,
      postalCode: postalCode !== (row.postalCode ?? "") ? postalCode : undefined,
      city: city !== (row.city ?? "") ? city : undefined,
    };
    const hasChanges = Object.values(patch).some((v) => v !== undefined);
    if (!hasChanges) return;
    await onSaveAll(row.id, patch, fullName);
  }

  return (
    <BottomSheet open onClose={onClose} ariaLabel={row.name} title={row.name} t={t}>
      <div className="flex flex-col gap-2 mb-4">
        <div className="grid grid-cols-2 gap-2">
          <label style={LABEL_STYLE}>
            <span style={LABEL_TEXT_STYLE}>{t("Name", "Nombre")}</span>
            <Input
              type="text"
              value={firstName}
              onChange={(e) => { setFirstName(e.currentTarget.value); setNameError(null); }}
              disabled={isSaving}
              className="font-semibold"
              aria-required="true"
            />
          </label>
          <label style={LABEL_STYLE}>
            <span style={LABEL_TEXT_STYLE}>{t("Last name", "Apellido")}</span>
            <Input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.currentTarget.value)}
              disabled={isSaving}
            />
          </label>
        </div>
        {nameError && (
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>{nameError}</p>
        )}
        <label style={LABEL_STYLE}>
          <span style={LABEL_TEXT_STYLE}>{t("Phone", "Teléfono")}</span>
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
          <span style={LABEL_TEXT_STYLE}>CUIT/CUIL</span>
          <Input
            type="text"
            inputMode="numeric"
            value={taxId}
            onChange={(e) => setTaxId(e.currentTarget.value)}
            disabled={isSaving}
          />
        </label>
        <label style={LABEL_STYLE}>
          <span style={LABEL_TEXT_STYLE}>{t("Address", "Dirección")}</span>
          <Input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
            disabled={isSaving}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label style={LABEL_STYLE}>
            <span style={LABEL_TEXT_STYLE}>{t("Postal code", "Código postal")}</span>
            <Input
              type="text"
              inputMode="numeric"
              value={postalCode}
              onChange={(e) => setPostalCode(e.currentTarget.value)}
              disabled={isSaving}
            />
          </label>
          <label style={LABEL_STYLE}>
            <span style={LABEL_TEXT_STYLE}>{t("City", "Ciudad")}</span>
            <Input
              type="text"
              value={city}
              onChange={(e) => setCity(e.currentTarget.value)}
              disabled={isSaving}
            />
          </label>
        </div>

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

      {clientInvoices.length > 0 && totalInvoiced > 0 && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600 }}>
            {t("Total billed", "Total facturado")}
          </span>
          <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 700, color: "var(--success)" }}>
            {moneyFmt(totalInvoiced, firstCurrency)}
          </span>
        </div>
      )}

      <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 700, marginBottom: "8px" }}>
        {t("Invoice history", "Historial de facturas")}
      </p>
      {clientInvoices.length === 0 ? (
        <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)" }}>
          {t("No invoices yet.", "Sin facturas aún.")}
        </p>
      ) : (
        clientInvoices.map((inv, index) => (
          <div
            key={inv.id}
            className="flex items-center justify-between gap-3 py-2.5"
            style={{ borderTop: index === 0 ? "none" : "1px solid var(--border)" }}
          >
            <div className="min-w-0">
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-strong)", fontWeight: 600 }}>
                #{inv.invoiceNumber}
              </p>
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", marginTop: "1px" }}>
                {formatDate(inv.issuedAt)}
              </p>
            </div>
            <div className="text-right flex-shrink-0 flex flex-col items-end gap-0.5">
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--tone-strong)" }}>
                {moneyFmt(inv.totalAmount, inv.currency)}
              </p>
              <span className="text-caption" style={{
                fontFamily: "var(--font-dm-sans)",
                fontWeight: 600,
                color: STATUS_COLOR[inv.status],
              }}>
                {t(STATUS_LABEL[inv.status].en, STATUS_LABEL[inv.status].es)}
              </span>
            </div>
          </div>
        ))
      )}

      <div style={{ borderTop: "1px solid var(--border)", marginTop: "16px", paddingTop: "16px" }}>
        {pendingDeleteId === row.id ? (
          <div className="flex items-center gap-2">
            <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)", flex: 1 }}>
              {t("Delete this customer?", "¿Eliminar este cliente?")}
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
            {t("Delete customer", "Eliminar cliente")}
          </button>
        )}
      </div>
    </BottomSheet>
  );
}
