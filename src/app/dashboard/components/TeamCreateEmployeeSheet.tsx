"use client";

import { type FormEvent, useEffect, useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { ErrorBanner } from "./ErrorBanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface TeamCreateEmployeeSheetProps {
  open: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: { name: string; pin: string }) => Promise<void>;
  t: (en: string, es: string) => string;
}

export function TeamCreateEmployeeSheet({
  open,
  saving,
  error,
  onClose,
  onSubmit,
  t,
}: TeamCreateEmployeeSheetProps) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setPin("");
      setLocalError(null);
    }
  }, [open]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setLocalError(null);

    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 60) {
      setLocalError(t("Name required (1–60 characters).", "Nombre requerido (1-60 caracteres)."));
      return;
    }
    if (!/^\d{4,8}$/.test(pin.trim())) {
      setLocalError(t("PIN: 4 to 8 numeric digits.", "PIN: 4 a 8 dígitos numéricos."));
      return;
    }

    await onSubmit({ name: trimmedName, pin: pin.trim() });
  }

  const displayError = localError ?? error;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      ariaLabel={t("Add employee", "Agregar empleado")}
      title={t("Add employee", "Agregar empleado")}
      t={t}
    >
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <p
          style={{
            margin: 0,
            color: "var(--tone-muted)",
            fontFamily: "var(--font-dm-sans)",
            fontSize: "0.9375rem",
          }}
        >
          {t(
            "The employee logs in from their phone with their PIN. Velora welcomes them and teaches them to operate.",
            "El empleado entra desde su celular con su PIN. Velora lo recibe y le enseña a operar.",
          )}
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          <span style={{ fontSize: "0.875rem", color: "var(--tone-muted)", fontFamily: "var(--font-dm-sans)" }}>
            {t("Employee name", "Nombre del empleado")}
          </span>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Carlos"
            disabled={saving}
            autoComplete="off"
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          <span style={{ fontSize: "0.875rem", color: "var(--tone-muted)", fontFamily: "var(--font-dm-sans)" }}>
            {t("PIN (4–8 digits)", "PIN (4-8 dígitos)")}
          </span>
          <Input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="1234"
            disabled={saving}
            autoComplete="new-password"
            className="tracking-[0.25em]"
          />
        </label>

        {displayError && <ErrorBanner message={displayError} />}

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <Button
            type="button"
            onClick={onClose}
            disabled={saving}
            variant="secondary"
            className="flex-1"
          >
            {t("Cancel", "Cancelar")}
          </Button>
          <Button
            type="submit"
            disabled={saving}
            className="flex-1"
          >
            {saving ? t("Creating…", "Creando…") : t("Create employee", "Crear empleado")}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}
