"use client";

import { type FormEvent } from "react";
import { BottomSheet } from "./BottomSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ClientDraft = { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string };

const IVA_OPTIONS = ["Consumidor Final", "Monotributista", "Responsable Inscripto", "Exento"] as const;
type SupplierDraft = { name: string; phone: string; email: string; contactName: string; leadTimeDays: string };

export const EMPTY_CLIENT_DRAFT: ClientDraft = { firstName: "", lastName: "", phone: "", email: "", taxId: "", ivaCondition: "", address: "", postalCode: "", city: "", dni: "" };
export const EMPTY_SUPPLIER_DRAFT: SupplierDraft = { name: "", phone: "", email: "", contactName: "", leadTimeDays: "3" };

interface ContactCreateSheetProps {
  isClients: boolean;
  newClient: ClientDraft;
  setNewClient: (updater: (current: ClientDraft) => ClientDraft) => void;
  clientSaving: boolean;
  clientError: string | null;
  clientNotice: string | null;
  newSupplier: SupplierDraft;
  setNewSupplier: (updater: (current: SupplierDraft) => SupplierDraft) => void;
  supplierSaving: boolean;
  supplierError: string | null;
  supplierNotice: string | null;
  resetContactSheet: () => void;
  handleCreateAndClose: (e: FormEvent<HTMLFormElement>) => Promise<void>;
  t: (en: string, es: string) => string;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function ContactCreateSheet({
  isClients,
  newClient,
  setNewClient,
  clientSaving,
  clientError,
  clientNotice,
  newSupplier,
  setNewSupplier,
  supplierSaving,
  supplierError,
  supplierNotice,
  resetContactSheet,
  handleCreateAndClose,
  t,
}: ContactCreateSheetProps) {
  const title = isClients ? t("New customer", "Nuevo cliente") : t("New supplier", "Nuevo proveedor");

  return (
    <BottomSheet
      open
      onClose={resetContactSheet}
      ariaLabel={title}
      title={title}
      maxHeight="90dvh"
      trackKeyboard
      t={t}
    >
      {isClients ? (
        <form onSubmit={(e) => { void handleCreateAndClose(e); }} className="flex flex-col gap-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <Input
              type="text"
              value={newClient.firstName}
              onChange={(e) => { const v = e.currentTarget.value; setNewClient((c) => ({ ...c, firstName: v })); }}
              placeholder={t("Name *", "Nombre *")}
              required
              autoFocus
            />
            <Input
              type="text"
              value={newClient.lastName}
              onChange={(e) => { const v = e.currentTarget.value; setNewClient((c) => ({ ...c, lastName: v })); }}
              placeholder={t("Last name", "Apellido")}
            />
          </div>
          <Input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={newClient.phone}
            onChange={(e) => { const v = e.currentTarget.value; setNewClient((c) => ({ ...c, phone: v })); }}
            placeholder={t("Phone (optional)", "Teléfono (opcional)")}
          />
          <Input
            type="email"
            value={newClient.email}
            onChange={(e) => { const v = e.currentTarget.value; setNewClient((c) => ({ ...c, email: v })); }}
            placeholder={t("Email (optional)", "Mail (opcional)")}
          />
          <Input
            type="text"
            inputMode="numeric"
            value={newClient.taxId}
            onChange={(e) => { const v = e.currentTarget.value; setNewClient((c) => ({ ...c, taxId: v })); }}
            placeholder={t("CUIT/CUIL (optional)", "CUIT/CUIL (opcional)")}
          />
          <Select
            value={newClient.ivaCondition || undefined}
            onValueChange={(v) => setNewClient((c) => ({ ...c, ivaCondition: v }))}
          >
            <SelectTrigger aria-label={t("IVA condition (optional)", "Condición IVA (opcional)")}>
              <SelectValue placeholder={t("IVA condition (optional)", "Condición IVA (opcional)")} />
            </SelectTrigger>
            <SelectContent>
              {IVA_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="text"
            value={newClient.address}
            onChange={(e) => { const v = e.currentTarget.value; setNewClient((c) => ({ ...c, address: v })); }}
            placeholder={t("Address (optional)", "Dirección (opcional)")}
          />
          <div className="grid grid-cols-2 gap-2.5">
            <Input
              type="text"
              inputMode="numeric"
              value={newClient.postalCode}
              onChange={(e) => { const v = e.currentTarget.value; setNewClient((c) => ({ ...c, postalCode: v })); }}
              placeholder={t("Postal code", "Código postal")}
            />
            <Input
              type="text"
              value={newClient.city}
              onChange={(e) => { const v = e.currentTarget.value; setNewClient((c) => ({ ...c, city: v })); }}
              placeholder={t("City (optional)", "Ciudad (opcional)")}
            />
          </div>
          <Input
            type="text"
            inputMode="numeric"
            value={newClient.dni}
            onChange={(e) => { const v = e.currentTarget.value; setNewClient((c) => ({ ...c, dni: v })); }}
            placeholder={t("DNI (optional)", "DNI (opcional)")}
            maxLength={8}
          />
          {clientError && <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>{clientError}</p>}
          {clientNotice && <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--success)" }}>{clientNotice}</p>}
          <Button type="submit" disabled={clientSaving} className="mt-1 w-full">
            {clientSaving ? t("Saving…", "Guardando…") : t("Add customer", "Agregar cliente")}
          </Button>
        </form>
      ) : (
        <form onSubmit={(e) => { void handleCreateAndClose(e); }} className="flex flex-col gap-2.5">
          <Input
            type="text"
            value={newSupplier.name}
            onChange={(e) => { const v = e.currentTarget.value; setNewSupplier((c) => ({ ...c, name: v })); }}
            placeholder={t("Supplier name *", "Nombre del proveedor *")}
            required
            autoFocus
          />
          <Input
            type="text"
            value={newSupplier.contactName}
            onChange={(e) => { const v = e.currentTarget.value; setNewSupplier((c) => ({ ...c, contactName: v })); }}
            placeholder={t("Contact name (optional)", "Nombre de contacto (opcional)")}
          />
          <Input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={newSupplier.phone}
            onChange={(e) => { const v = e.currentTarget.value; setNewSupplier((c) => ({ ...c, phone: v })); }}
            placeholder={t("Phone / WhatsApp (optional)", "Tel / WhatsApp (opcional)")}
          />
          <Input
            type="email"
            value={newSupplier.email}
            onChange={(e) => { const v = e.currentTarget.value; setNewSupplier((c) => ({ ...c, email: v })); }}
            placeholder={t("Email (optional)", "Mail (opcional)")}
          />
          {supplierError && <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>{supplierError}</p>}
          {supplierNotice && <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--success)" }}>{supplierNotice}</p>}
          <Button type="submit" disabled={supplierSaving} className="mt-1 w-full">
            {supplierSaving ? t("Saving…", "Guardando…") : t("Add supplier", "Agregar proveedor")}
          </Button>
        </form>
      )}
    </BottomSheet>
  );
}
