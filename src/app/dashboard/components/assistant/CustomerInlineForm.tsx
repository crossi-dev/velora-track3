"use client";

// Inline form rendered in the chat to capture the 5 mandatory customer fields
// + optional CUIT. Used by:
//  - T_CUSTOMERS onboarding turn ("Cargar manual" choice) — dispatched via the
//    velora:open-customer-form window event.
//  - Sale-create picker ("+ Crear nuevo cliente") — same dispatch.
//
// Persists via executeDashboardAction("customer.create") so the call goes
// through the canonical Action Node (idempotency + audit handled centrally).
// On success, fires onCreated with the persisted customer.

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { executeDashboardAction } from "../../lib/actions/executeDashboardAction";

export interface CustomerFormSubmitResult {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  postalCode: string | null;
  dni: string | null;
  taxId: string | null;
}

interface CustomerInlineFormProps {
  businessId: string;
  onCreated: (customer: CustomerFormSubmitResult) => void;
  onCancel: () => void;
  t: (en: string, es: string) => string;
}

const DNI_RE = /^\d{7,8}$/;
const CUIT_RE = /^\d{2}-?\d{8}-?\d$/;
const PHONE_RE = /^\+?\d{10,13}$/;
const CP_RE = /^\d{4,5}$/;

function normalizePhone(value: string): string {
  return value.replace(/[\s().-]/g, "");
}

function normalizeCuit(value: string): string {
  return value.replace(/[\s-]/g, "");
}

export function CustomerInlineForm({ businessId, onCreated, onCancel, t }: CustomerInlineFormProps) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [dni, setDni] = useState("");
  const [taxId, setTaxId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if (!name.trim()) return t("Name is required.", "El nombre es obligatorio.");
    const normPhone = normalizePhone(phone);
    if (!normPhone) return t("Phone is required.", "El teléfono es obligatorio.");
    if (!PHONE_RE.test(normPhone)) return t("Phone must be 10-13 digits.", "El teléfono debe tener 10-13 dígitos.");
    if (!address.trim()) return t("Address is required for shipping.", "La dirección es obligatoria para envíos.");
    if (!postalCode.trim()) return t("Postal code is required.", "El código postal es obligatorio.");
    if (!CP_RE.test(postalCode.trim())) return t("Postal code must be 4-5 digits.", "El código postal debe tener 4 o 5 dígitos.");
    if (!dni.trim()) return t("DNI is required for shipping.", "El DNI es obligatorio para envíos.");
    if (!DNI_RE.test(dni.trim())) return t("DNI must be 7-8 digits.", "El DNI debe tener 7 u 8 dígitos.");
    if (taxId.trim()) {
      const normCuit = normalizeCuit(taxId);
      if (!CUIT_RE.test(normCuit)) return t("CUIT must be 11 digits.", "El CUIT debe tener 11 dígitos.");
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setLoading(true);
    try {
      const result = await executeDashboardAction("customer.create", {
        businessId,
        name: name.trim(),
        phone: normalizePhone(phone),
        email: email.trim() || null,
        address: address.trim(),
        postalCode: postalCode.trim(),
        dni: dni.trim(),
        taxId: taxId.trim() ? normalizeCuit(taxId) : null,
      });
      const customer = (result as { customer?: CustomerFormSubmitResult } | null)?.customer;
      if (!customer) {
        setError(t("Could not save the customer.", "No se pudo guardar el cliente."));
        return;
      }
      onCreated(customer);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("Connection error saving the customer.", "Error de conexión al guardar el cliente.");
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 p-4 mt-2"
      style={{
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--border)",
        backgroundColor: "var(--surface-subtle)",
      }}
    >
      <div>
        <label htmlFor="cust-name" className="block text-sm mb-1" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}>
          {t("Name", "Nombre")}
        </label>
        <Input id="cust-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </div>
      <div>
        <label htmlFor="cust-phone" className="block text-sm mb-1" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}>
          {t("Phone (WhatsApp)", "Teléfono (WhatsApp)")}
        </label>
        <Input id="cust-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="1100000000" required />
      </div>
      <div>
        <label htmlFor="cust-email" className="block text-sm mb-1" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}>
          {t("Email (optional)", "Mail (opcional)")}
        </label>
        <Input id="cust-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@mail.com" />
      </div>
      <div>
        <label htmlFor="cust-address" className="block text-sm mb-1" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}>
          {t("Address", "Dirección")}
        </label>
        <Input id="cust-address" type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t("Street and number", "Calle y número")} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="cust-cp" className="block text-sm mb-1" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}>
            {t("Postal code", "Código postal")}
          </label>
          <Input id="cust-cp" type="text" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} placeholder="5500" required maxLength={5} />
        </div>
        <div>
          <label htmlFor="cust-dni" className="block text-sm mb-1" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}>
            {t("DNI", "DNI")}
          </label>
          <Input id="cust-dni" type="text" value={dni} onChange={(e) => setDni(e.target.value)} placeholder="12345678" required maxLength={8} />
        </div>
      </div>
      <div>
        <label htmlFor="cust-cuit" className="block text-sm mb-1" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}>
          {t("CUIT (optional)", "CUIT (opcional)")}
        </label>
        <Input id="cust-cuit" type="text" value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="20-12345678-9" maxLength={13} />
      </div>
      {error ? (
        <p className="text-sm" style={{ color: "var(--danger)", fontFamily: "var(--font-dm-sans)" }}>{error}</p>
      ) : null}
      <div className="flex gap-2 justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={loading}
          className="rounded-full"
          style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px" }}
        >
          {t("Cancel", "Cancelar")}
        </Button>
        <Button
          type="submit"
          disabled={loading}
          className="rounded-full"
          style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", backgroundColor: "var(--action-primary-bg)", color: "var(--action-primary-fg)" }}
        >
          {loading ? t("Saving…", "Guardando…") : t("Save customer", "Guardar cliente")}
        </Button>
      </div>
    </form>
  );
}
