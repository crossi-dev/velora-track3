"use client";

import { type FormEvent, useState, useEffect, useCallback } from "react";
import type { SettingsFormState, BusinessSummary } from "../lib/types";
import { type AppSettings, DEFAULT_APP_SETTINGS, getAppSettings, saveAppSettings, applyAppSettingsToDOM } from "../lib/appSettings";
import { SegmentControl } from "./SettingsShared";
import { SettingsNegocioSection } from "./SettingsNegocioSection";
import { SettingsAplicacionSection } from "./SettingsAplicacionSection";
import { SectionMarker } from "./v2/SectionMarker";

function buildSettingsFormFromBusiness(business: BusinessSummary): SettingsFormState {
  return {
    name: business.name ?? "",
    type: business.type ?? "",
    address: business.address ?? "",
    phone: business.phone ?? "",
    whatsappPhone: business.whatsappPhone ?? "",
    alias: business.alias ?? "",
    currency: business.currency ?? "ARS",
    defaultCustomer: business.defaultCustomer ?? "Consumidor Final",
    allowSaleWithoutCustomer: business.allowSaleWithoutCustomer ?? true,
    openReceiptAfterSale: business.openReceiptAfterSale ?? false,
    autoCreateProductOnStockLoad: business.autoCreateProductOnStockLoad ?? false,
    suggestWhatsappAfterSale: business.suggestWhatsappAfterSale ?? true,
    lowStockThreshold: business.lowStockThreshold ?? 5,
    allowNegativeStock: business.allowNegativeStock ?? false,
    notifyLowStockWa: business.notifyLowStockWa ?? false,
    cuit: business.cuit ?? "",
    ivaCondition: business.ivaCondition ?? "",
    puntoVenta: business.puntoVenta ?? "",
    postalCode: business.postalCode ?? "",
    courierPreference: business.courierPreference ?? "",
  };
}

interface SettingsTabProps {
  business: BusinessSummary;
  settingsForm: SettingsFormState;
  settingsSaving: boolean;
  settingsError: string | null;
  settingsNotice: string | null;
  updateSettingsField: (field: keyof SettingsFormState, value: string) => void;
  handleSaveSettings: (event: FormEvent<HTMLFormElement>) => void;
  setSettingsForm: (form: SettingsFormState) => void;
  setSettingsError: (value: string | null) => void;
  setSettingsNotice: (value: string | null) => void;
  t: (en: string, es: string) => string;
}

export function SettingsTab({
  business,
  settingsForm,
  settingsSaving,
  settingsError,
  settingsNotice,
  updateSettingsField,
  handleSaveSettings,
  setSettingsForm,
  setSettingsError,
  setSettingsNotice,
  t,
}: SettingsTabProps) {
  const initialSettingsForm = buildSettingsFormFromBusiness(business);
  const isSettingsDirty = Object.entries(settingsForm).some(
    ([field, value]) => value !== initialSettingsForm[field as keyof SettingsFormState]
  );

  const [activeSection, setActiveSection] = useState<"negocio" | "aplicacion">("negocio");
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);

  useEffect(() => {
    setAppSettings(getAppSettings());
  }, []);

  // Read ?panel= from URL (set by chat-driven clientAction "open_settings") and
  // scroll to the requested card. Panel format: "negocio.<id>" or "logistica.<id>".
  // The supervisor onboarding (T5b courier, T8a fiscal) and credential-update
  // handler emit these. Without scroll, the owner lands on Settings but has to
  // hunt the card manually.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const panel = params.get("panel");
    if (!panel) return;

    // Force "negocio" section since all panel targets live there today.
    setActiveSection("negocio");

    const PANEL_TO_CARD: Record<string, string> = {
      "negocio.fiscal": "settings-card-negocio-fiscal",
      "negocio.mercadopago": "settings-card-negocio-mercadopago",
      "negocio.modo": "settings-card-negocio-modo",
      "logistica.andreani": "settings-card-logistica",
      "logistica.oca": "settings-card-logistica",
      "logistica.correo": "settings-card-logistica",
    };
    const cardId = PANEL_TO_CARD[panel];
    if (!cardId) return;

    // Defer to next paint so the section render commits before we scroll.
    const timer = setTimeout(() => {
      const el = document.getElementById(cardId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const updateApp = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setAppSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveAppSettings(next);
      applyAppSettingsToDOM();
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col gap-4" style={{ maxWidth: "640px", margin: "0 auto", width: "100%" }}>
      {/* v2 editorial header */}
      <div className="flex flex-col gap-1.5">
        <SectionMarker label="System" number="07" />
        <h1
          className="t-display-3"
          style={{ color: "var(--tone-strong)", margin: 0 }}
        >
          {t("Settings", "Configuración")}
        </h1>
      </div>

      <SegmentControl
        options={[
          { value: "negocio" as const, label: t("Business", "Negocio") },
          { value: "aplicacion" as const, label: t("App", "Aplicación") },
        ]}
        value={activeSection}
        onChange={setActiveSection}
      />

      {activeSection === "negocio" && (
        <SettingsNegocioSection
          settingsForm={settingsForm}
          settingsSaving={settingsSaving}
          settingsError={settingsError}
          settingsNotice={settingsNotice}
          isSettingsDirty={isSettingsDirty}
          initialSettingsForm={initialSettingsForm}
          updateSettingsField={updateSettingsField}
          handleSaveSettings={handleSaveSettings}
          setSettingsForm={setSettingsForm}
          setSettingsError={setSettingsError}
          setSettingsNotice={setSettingsNotice}
        />
      )}

      {activeSection === "aplicacion" && (
        <SettingsAplicacionSection
          appSettings={appSettings}
          updateApp={updateApp}
        />
      )}

      <style jsx>{`
        @media (min-width: 768px) {
          .settings-card {
            padding: 20px !important;
          }
        }
      `}</style>
    </div>
  );
}
