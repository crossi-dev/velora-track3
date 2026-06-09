"use client";

import type React from "react";
import type { SettingsFormState } from "../lib/types";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LABEL_STYLE,
  COMPACT_FIELD_STYLE,
  CARD_CLASS,
  CARD_STYLE,
  CARD_TITLE_STYLE,
} from "./SettingsShared";

const HINT_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.875rem",
  color: "var(--tone-muted)",
  fontStyle: "italic",
  marginTop: "2px",
};

interface SettingsFiscalCardProps {
  settingsForm: SettingsFormState;
  updateSettingsField: (field: keyof SettingsFormState, value: string) => void;
  t: (en: string, es: string) => string;
}

export function SettingsFiscalCard({
  settingsForm,
  updateSettingsField,
  t,
}: SettingsFiscalCardProps) {
  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <p style={CARD_TITLE_STYLE}>{t("Fiscal & shipping", "Datos fiscales y envíos")}</p>
      <div className="grid gap-x-3 gap-y-2.5 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span style={LABEL_STYLE}>CUIT</span>
          <Input
            type="text"
            inputMode="numeric"
            placeholder="XX-XXXXXXXX-X"
            value={settingsForm.cuit}
            onChange={(e) => updateSettingsField("cuit", e.target.value)}
            style={COMPACT_FIELD_STYLE}
            autoComplete="off"
          />
          <span style={HINT_STYLE}>{t("Required for formal invoices.", "Requerido para facturas formales.")}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span style={LABEL_STYLE}>{t("IVA condition", "Condición IVA")}</span>
          <Select
            value={settingsForm.ivaCondition}
            onValueChange={(value) => updateSettingsField("ivaCondition", value)}
          >
            <SelectTrigger
              style={COMPACT_FIELD_STYLE}
              aria-label={t("IVA condition", "Condición IVA")}
            >
              <SelectValue placeholder={t("— not set —", "— sin definir —")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Monotributista">Monotributista</SelectItem>
              <SelectItem value="Responsable Inscripto">Responsable Inscripto</SelectItem>
              <SelectItem value="Exento">Exento</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span style={LABEL_STYLE}>{t("Punto de venta", "Punto de venta")}</span>
          <Input
            type="text"
            inputMode="numeric"
            placeholder="0001"
            value={settingsForm.puntoVenta}
            onChange={(e) => updateSettingsField("puntoVenta", e.target.value)}
            style={COMPACT_FIELD_STYLE}
          />
          <span style={HINT_STYLE}>{t("AFIP sales point number.", "Número de punto de venta AFIP.")}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span style={LABEL_STYLE}>{t("Origin postal code", "Código postal de origen")}</span>
          <Input
            type="text"
            inputMode="numeric"
            maxLength={10}
            placeholder="1234"
            value={settingsForm.postalCode}
            onChange={(e) => updateSettingsField("postalCode", e.target.value)}
            style={{ ...COMPACT_FIELD_STYLE, maxWidth: "8rem" }}
          />
          <span style={HINT_STYLE}>{t("Where you ship from — used to quote Andreani rates.", "Desde dónde despachás tus envíos — lo usamos para cotizar Andreani.")}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span style={LABEL_STYLE}>{t("Preferred courier", "Courier preferido")}</span>
          <Select
            value={settingsForm.courierPreference}
            onValueChange={(value) => updateSettingsField("courierPreference", value)}
          >
            <SelectTrigger
              style={{ ...COMPACT_FIELD_STYLE, maxWidth: "12rem" }}
              aria-label={t("Preferred courier", "Courier preferido")}
            >
              <SelectValue placeholder={t("— not set —", "— sin definir —")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Andreani">Andreani</SelectItem>
              <SelectItem value="OCA">OCA</SelectItem>
              <SelectItem value="ninguno">{t("None", "Ninguno")}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
    </div>
  );
}
