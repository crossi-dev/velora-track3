"use client";

import React, { type FormEvent } from "react";
import type { SettingsFormState } from "../lib/types";
import { useT } from "../lib/DashboardLangContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InlineNotice } from "./InlineNotice";
import { SettingsMercadoPagoCard } from "./SettingsMercadoPagoCard";
// SettingsModoCard ENCAJONADO 2026-05-25 — import preserved as comment for restore.
// import { SettingsModoCard } from "./SettingsModoCard";
import { SettingsPeersCard } from "./SettingsPeersCard";
import { SettingsFiscalCard } from "./SettingsFiscalCard";
import { SettingsFiscalCertCard } from "./SettingsFiscalCertCard";
import { SettingsCourierCard } from "./SettingsCourierCard";
import {
  LABEL_STYLE,
  COMPACT_FIELD_STYLE,
  CARD_CLASS,
  CARD_STYLE,
  CARD_TITLE_STYLE,
  TOGGLE_ROW_STYLE,
  TOGGLE_LABEL_STYLE,
  Toggle,
} from "./SettingsShared";

interface SettingsNegocioSectionProps {
  settingsForm: SettingsFormState;
  settingsSaving: boolean;
  settingsError: string | null;
  settingsNotice: string | null;
  isSettingsDirty: boolean;
  initialSettingsForm: SettingsFormState;
  updateSettingsField: (field: keyof SettingsFormState, value: string) => void;
  handleSaveSettings: (event: FormEvent<HTMLFormElement>) => void;
  setSettingsForm: (form: SettingsFormState) => void;
  setSettingsError: (value: string | null) => void;
  setSettingsNotice: (value: string | null) => void;
}

const HINT_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.875rem",
  color: "var(--tone-muted)",
  fontStyle: "italic",
  marginTop: "2px",
};

const MEANINGFUL_FIELDS: (keyof SettingsFormState)[] = [
  "name", "type", "phone", "whatsappPhone", "address",
  "currency", "cuit", "ivaCondition", "puntoVenta", "postalCode", "courierPreference",
];

function countFilledFields(form: SettingsFormState): number {
  return MEANINGFUL_FIELDS.filter((f) => {
    const v = form[f];
    return typeof v === "string" ? v.trim().length > 0 : Boolean(v);
  }).length;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function SettingsNegocioSection({
  settingsForm,
  settingsSaving,
  settingsError,
  settingsNotice,
  isSettingsDirty,
  initialSettingsForm,
  updateSettingsField,
  handleSaveSettings,
  setSettingsForm,
  setSettingsError,
  setSettingsNotice,
}: SettingsNegocioSectionProps) {
  const t = useT();
  const setField = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) =>
    setSettingsForm({ ...settingsForm, [key]: value });

  const filled = countFilledFields(settingsForm);
  const total = MEANINGFUL_FIELDS.length;

  return (
    <div className="flex flex-col gap-4">
      <div
        style={{
          fontFamily: "var(--font-dm-sans)",
          fontSize: "0.875rem",
          color: "var(--tone-muted)",
          marginBottom: "var(--space-4)",
        }}
      >
        {t(`${filled} of ${total} fields filled`, `${filled} de ${total} campos completos`)}
      </div>
      <form
        onSubmit={(event) => {
          if (!isSettingsDirty || settingsSaving) { event.preventDefault(); return; }
          void handleSaveSettings(event);
        }}
        className="flex flex-col gap-4"
      >
        {/* ── Card 1: Perfil del negocio ── */}
        <div className={CARD_CLASS} style={CARD_STYLE}>
          <p style={CARD_TITLE_STYLE}>{t("Business profile", "Perfil del negocio")}</p>
          <div className="grid gap-x-3 gap-y-2.5 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span style={LABEL_STYLE}>{t("Business name", "Nombre del negocio")}</span>
              <Input type="text" value={settingsForm.name} onChange={(e) => updateSettingsField("name", e.target.value)} style={COMPACT_FIELD_STYLE} />
              <span style={HINT_STYLE}>{t("Velora uses this when greeting employees and on receipts.", "Velora lo usa al saludar a tus empleados y en los comprobantes.")}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span style={LABEL_STYLE}>{t("Business type", "Tipo de negocio")}</span>
              <Input type="text" value={settingsForm.type} onChange={(e) => updateSettingsField("type", e.target.value)} placeholder="Ej: Ropa, Ferretería, Kiosco" style={COMPACT_FIELD_STYLE} />
              <span style={HINT_STYLE}>{t("Helps Velora suggest relevant rules and actions.", "Ayuda a Velora a sugerir reglas y acciones relevantes.")}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span style={LABEL_STYLE}>{t("Phone", "Teléfono")}</span>
              <Input type="tel" inputMode="tel" autoComplete="tel" value={settingsForm.phone} onChange={(e) => updateSettingsField("phone", e.target.value)} style={COMPACT_FIELD_STYLE} />
              <span style={HINT_STYLE}>{t("Shown on invoices and receipts.", "Para mostrar en facturas y comprobantes.")}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span style={LABEL_STYLE}>{t("WhatsApp", "WhatsApp")}</span>
              <Input type="tel" inputMode="tel" autoComplete="tel" placeholder="+549..." value={settingsForm.whatsappPhone} onChange={(e) => updateSettingsField("whatsappPhone", e.target.value)} style={COMPACT_FIELD_STYLE} />
              <span style={HINT_STYLE}>{t("Enables sending automatic receipts via WhatsApp to customers.", "Habilita enviar recibos automáticos por WhatsApp a clientes.")}</span>
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <span style={LABEL_STYLE}>{t("Address", "Dirección")}</span>
              <Input type="text" value={settingsForm.address} onChange={(e) => updateSettingsField("address", e.target.value)} style={COMPACT_FIELD_STYLE} />
              <span style={HINT_STYLE}>{t("Appears on formal receipts. Optional.", "Aparece en comprobantes formales. Opcional.")}</span>
            </label>
          </div>
        </div>

        {/* ── Card 2: Datos fiscales y envíos ── */}
        <SettingsFiscalCard
          settingsForm={settingsForm}
          updateSettingsField={updateSettingsField}
          t={t}
        />

        {/* ── Card 2b: Certificado ARCA (.p12 upload) ── */}
        <div id="settings-card-negocio-fiscal">
          <SettingsFiscalCertCard />
        </div>

        {/* ── Card 3: Ventas ── */}
        <div className={CARD_CLASS} style={CARD_STYLE}>
          <p style={CARD_TITLE_STYLE}>{t("Sales", "Ventas")}</p>
          <div className="flex flex-col gap-2.5">
            <div className="grid gap-x-3 gap-y-2.5 md:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span style={LABEL_STYLE}>{t("Currency", "Moneda")}</span>
                <Select
                  value={settingsForm.currency}
                  onValueChange={(value) => updateSettingsField("currency", value)}
                >
                  <SelectTrigger
                    style={{ ...COMPACT_FIELD_STYLE, maxWidth: "8rem" }}
                    aria-label={t("Currency", "Moneda")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ARS">ARS</SelectItem>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                    <SelectItem value="BRL">BRL</SelectItem>
                  </SelectContent>
                </Select>
                <span style={HINT_STYLE}>{t("Used to display prices and record sales.", "Para mostrar precios y registrar ventas.")}</span>
              </label>
              <label className="flex flex-col gap-1">
                <span style={LABEL_STYLE}>{t("Default customer", "Cliente por defecto")}</span>
                <Input type="text" value={settingsForm.defaultCustomer} onChange={(e) => updateSettingsField("defaultCustomer", e.target.value)} style={COMPACT_FIELD_STYLE} />
              </label>
            </div>
            <div style={TOGGLE_ROW_STYLE}>
              <span style={TOGGLE_LABEL_STYLE}>{t("Allow sale without customer", "Permitir venta sin cliente")}</span>
              <Toggle checked={settingsForm.allowSaleWithoutCustomer} onChange={(v) => setField("allowSaleWithoutCustomer", v)} label={t("Allow sale without customer", "Permitir venta sin cliente")} />
            </div>
            <div style={TOGGLE_ROW_STYLE}>
              <span style={TOGGLE_LABEL_STYLE}>{t("Open receipt after sale", "Abrir recibo tras la venta")}</span>
              <Toggle checked={settingsForm.openReceiptAfterSale} onChange={(v) => setField("openReceiptAfterSale", v)} label={t("Open receipt after sale", "Abrir recibo tras la venta")} />
            </div>
            <div style={TOGGLE_ROW_STYLE}>
              <span style={TOGGLE_LABEL_STYLE}>{t("Suggest sending via WhatsApp after sale", "Sugerir envío por WhatsApp tras la venta")}</span>
              <Toggle checked={settingsForm.suggestWhatsappAfterSale} onChange={(v) => setField("suggestWhatsappAfterSale", v)} label={t("Suggest sending via WhatsApp after sale", "Sugerir envío por WhatsApp tras la venta")} />
            </div>
          </div>
        </div>

        {/* ── Card 4: Inventario ── */}
        <div className={CARD_CLASS} style={CARD_STYLE}>
          <p style={CARD_TITLE_STYLE}>{t("Inventory", "Inventario")}</p>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
              <div style={TOGGLE_ROW_STYLE}>
                <span style={TOGGLE_LABEL_STYLE}>{t("Warn on low stock from", "Avisar por stock bajo desde")}</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={settingsForm.lowStockThreshold}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isFinite(v) && v >= 0) setField("lowStockThreshold", v);
                  }}
                  className="w-20 text-center"
                  style={COMPACT_FIELD_STYLE}
                />
              </div>
              <span style={HINT_STYLE}>{t("When stock drops below this number, Velora notifies you.", "Cuando el stock baja de este número, Velora te avisa.")}</span>
            </div>
            <div style={TOGGLE_ROW_STYLE}>
              <span style={TOGGLE_LABEL_STYLE}>{t("Allow negative stock", "Permitir stock negativo")}</span>
              <Toggle checked={settingsForm.allowNegativeStock} onChange={(v) => setField("allowNegativeStock", v)} label={t("Allow negative stock", "Permitir stock negativo")} />
            </div>
            <div style={TOGGLE_ROW_STYLE}>
              <span style={TOGGLE_LABEL_STYLE}>{t("Auto-create product on stock load", "Crear producto automáticamente al cargar stock")}</span>
              <Toggle checked={settingsForm.autoCreateProductOnStockLoad} onChange={(v) => setField("autoCreateProductOnStockLoad", v)} label={t("Auto-create product on stock load", "Crear producto automáticamente al cargar stock")} />
            </div>
          </div>
        </div>

        {/* ── Card 4b: Notificaciones por WhatsApp ── */}
        <div className={CARD_CLASS} style={CARD_STYLE}>
          <p style={CARD_TITLE_STYLE}>{t("WhatsApp Notifications", "Notificaciones por WhatsApp")}</p>
          <div className="flex flex-col gap-2.5">
            <div style={TOGGLE_ROW_STYLE}>
              <span style={TOGGLE_LABEL_STYLE}>
                {t(
                  "Alert me on WhatsApp when a product runs low",
                  "Avisarme al WhatsApp cuando un producto queda con stock bajo",
                )}
              </span>
              <Toggle
                checked={settingsForm.notifyLowStockWa}
                onChange={(v) => setField("notifyLowStockWa", v)}
                label={t("Alert me on WhatsApp when a product runs low", "Avisarme al WhatsApp cuando un producto queda con stock bajo")}
              />
            </div>
            <span style={HINT_STYLE}>
              {t(
                "When enabled, every sale that drops a product below the threshold sends you a WhatsApp. Default: off.",
                "Si está prendido, cada venta que deje un producto bajo del umbral te manda un wpp. Default: apagado.",
              )}
            </span>
          </div>
        </div>

        {/* ── Card 5: Mercado Pago (slice 7 — OAuth) ── */}
        <div id="settings-card-negocio-mercadopago">
          <SettingsMercadoPagoCard />
        </div>

        {/* ── Card 5c: MODO ENCAJONADO 2026-05-25 — restore by uncommenting.
        <div id="settings-card-negocio-modo">
          <SettingsModoCard />
        </div>
        */}

        {/* ── Card 5b: Courier / Logística (per-business bring-your-own-account) ── */}
        <div id="settings-card-logistica">
          <SettingsCourierCard />
        </div>

        {/* ── Card 6: Trusted Peer Agents (A2A external) ── */}
        <SettingsPeersCard />

        {/* ── Notices ── */}
        {settingsError ? <InlineNotice message={settingsError} tone="error" /> : null}
        {!settingsError && settingsNotice ? <InlineNotice message={settingsNotice} tone="success" /> : null}

        {/* ── Sticky save bar (only when dirty) ── */}
        {isSettingsDirty && (
          <div
            className="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-token-lg border px-4 py-3"
            style={{
              backgroundColor: "var(--surface)",
              borderColor: "var(--border)",
              boxShadow: "none",
              paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
            }}
          >
            <p className="text-caption" style={{
              fontFamily: "var(--font-dm-sans)",
              fontWeight: 600,
              margin: 0,
            }}>
              {t("Unsaved changes", "Cambios sin guardar")}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={settingsSaving}
                onClick={() => {
                  setSettingsForm(initialSettingsForm);
                  setSettingsError(null);
                  setSettingsNotice(null);
                }}
              >
                {t("Discard", "Descartar")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={settingsSaving}
              >
                {settingsSaving ? t("Saving…", "Guardando…") : t("Save", "Guardar")}
              </Button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
